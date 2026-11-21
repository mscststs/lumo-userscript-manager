import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AgentSettings, UserScript } from '@/types';
import { deleteDraft, getResources, getScript, getScriptWithCode, listScripts } from '@/lib/db';
import {
  commitInstall,
  prepareInstall,
  removeScript,
  restoreDeletedScript,
  saveScriptFromCode,
  setScriptsEnabled,
} from '@/lib/background/scripts';
import { checkUserScriptsAvailable, getRuntimeStatus } from '@/lib/background/registry';
import { evaluateScripts, type EvaluatedScript } from '@/lib/background/matching';
import { analyzeScriptCode } from '@/lib/script/analyze';
import { AppError } from '@/lib/errors';
import { applyEdits } from '@/lib/script/edit';
import { formatDiagnostic } from '@/lib/diagnostics';
import { splitTags } from '@/lib/script/metadata';
import { resolveAgentAccess, type AgentAccess } from './policy';
import { recordAgentAudit } from './audit';
import { toDetail, toSummary } from './dto';

/** Largest single page `get` will hand back when the caller pages explicitly. */
const CODE_PAGE_MAX = 128 * 1024;
/** Largest single page `list` will hand back. */
const LIST_PAGE_MAX = 200;
/** Refuse to parse or store arbitrarily large agent input. */
const CODE_INPUT_MAX = 5 * 1024 * 1024;
/** Candidates named in an AMBIGUOUS answer. */
const CANDIDATE_LIMIT = 10;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ok(payload: unknown): CallToolResult {
  // Text only. A host that converts a CallToolResult into a model prompt keeps
  // `content` and `structuredContent` both, so emitting the same payload twice
  // doubles the tokens of every answer — and `get` answers with a whole source.
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Marks a `failed(...)` answer.
 *
 * Read handlers return a payload and `guardedRead` wraps it; a handler that
 * answers with `failed(...)` instead must not be wrapped a second time. A brand
 * is cheaper and stricter than sniffing the result for `content`, which any
 * payload could grow by accident.
 */
const FAILURE = Symbol('userscripts.toolFailure');

type FailureResult = CallToolResult & { readonly [FAILURE]: true };

function isFailure(value: unknown): value is FailureResult {
  return isRecord(value) && FAILURE in value;
}

/**
 * A business failure the model can act on (conflict, not found, invalid input).
 * Distinct from protocol errors: it is a successful call with `isError`, so the
 * reason reaches the model instead of aborting the MCP request.
 *
 * The payload is JSON with a stable `code`, because an agent driving these tools
 * from a script has to branch on the reason, not on an English sentence.
 */
function failed(payload: Record<string, unknown>): FailureResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true, [FAILURE]: true };
}

/**
 * Turn a thrown domain error into the same JSON shape as `failed(...)`.
 *
 * Duplicate names, invalid metadata, oversized downloads and draft expiry are
 * thrown by the background layer; without this they would reach the model as
 * plain text while every other refusal is JSON.
 */
function failureFrom(error: unknown): CallToolResult {
  if (error instanceof AppError) {
    return failed({
      code: error.code,
      message: error.message,
      ...(error.params ? { params: error.params } : {}),
    });
  }
  return fail(messageOf(error));
}

function textOf(result: CallToolResult): string {
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (!first || typeof first !== 'object' || !('text' in first)) return '';
  return String((first as { text?: unknown }).text ?? '').slice(0, 500);
}

/**
 * Re-check the policy on every call, not just when the port opens.
 *
 * A session can outlive the user turning the endpoint off (or turning writes
 * off); failing closed here makes the switches effective immediately.
 */
async function requireAccess(senderId: string | undefined, needWrite: boolean): Promise<AgentAccess> {
  const access = await resolveAgentAccess(senderId);
  if (!access.enabled) throw new Error('The agent endpoint is disabled in Lumo Userscripts.');
  if (!access.authorized) throw new Error('This extension is not on the Lumo Userscripts allowlist.');
  if (needWrite && !access.settings.allowWrites) {
    throw new Error('Writing is disabled in Lumo Userscripts.');
  }
  return access;
}

/** Gate a read call; a handler may also answer with `failed(...)` itself. */
function guardedRead(
  senderId: string | undefined,
  run: () => Promise<unknown>,
): Promise<CallToolResult> {
  return requireAccess(senderId, false)
    .then(run)
    .then(
      (value) => (isFailure(value) ? value : ok(value)),
      failureFrom,
    );
}

/**
 * Gate and audit one write call.
 *
 * `run` receives the live access record (so `reviewWrites` is never stale) and
 * a mutable target holder used by the audit entry.
 */
async function guardedWrite(
  senderId: string | undefined,
  tool: string,
  args: unknown,
  run: (target: { uuid?: string }, access: AgentAccess) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const target: { uuid?: string } = {};

  let access: AgentAccess;
  try {
    access = await requireAccess(senderId, true);
  } catch (error) {
    await recordAgentAudit({ tool, senderId, args, result: 'error', message: messageOf(error) });
    return fail(messageOf(error));
  }

  try {
    const response = await run(target, access);
    await recordAgentAudit({
      tool,
      senderId,
      args,
      targetUuid: target.uuid,
      result: response.isError ? 'error' : 'ok',
      message: response.isError ? textOf(response) : undefined,
    });
    return response;
  } catch (error) {
    await recordAgentAudit({
      tool,
      senderId,
      args,
      targetUuid: target.uuid,
      result: 'error',
      message: messageOf(error),
    });
    return failureFrom(error);
  }
}

/** Base URL the script's relative `@require`/`@resource` entries resolve against. */
function sourceUrlOf(script: UserScript): string {
  return script.origin || script.downloadUrl || '';
}

/** A target reference: uuid wins, otherwise name + optional namespace. */
interface ScriptTargetRef {
  id?: string;
  name?: string;
  namespace?: string;
}

type ResolvedTarget =
  | { kind: 'found'; script: UserScript }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; total: number; candidates: unknown[] }
  | { kind: 'invalid' };

/** The two shapes `targetFailure` knows how to report. */
type FailedTarget = Extract<ResolvedTarget, { kind: 'ambiguous' } | { kind: 'invalid' }>;

/**
 * Resolve one script without guessing.
 *
 * Names are not unique, and silently picking the first match is how an agent
 * ends up rewriting the wrong script. A multi-match answer names the
 * candidates so the model can retry with an id.
 */
async function resolveTarget(ref: ScriptTargetRef): Promise<ResolvedTarget> {
  if (ref.id) {
    const script = await getScript(ref.id);
    return script ? { kind: 'found', script } : { kind: 'missing' };
  }
  if (!ref.name) return { kind: 'invalid' };

  const scripts = await listScripts(true);
  const named = scripts.filter(
    (script) => script.name === ref.name && (ref.namespace === undefined || script.namespace === ref.namespace),
  );
  if (named.length === 0) return { kind: 'missing' };
  if (named.length === 1) return { kind: 'found', script: named[0]! };
  return {
    kind: 'ambiguous',
    total: named.length,
    candidates: named.slice(0, CANDIDATE_LIMIT).map((script) => ({
      id: script.uuid,
      name: script.name,
      namespace: script.namespace,
      version: script.version,
      enabled: script.enabled && !script.removedAt,
      removed: Boolean(script.removedAt),
    })),
  };
}

/** The index filters `list` accepts, already normalized (lower-case query/tag). */
interface ListFilters {
  query?: string;
  tag?: string;
  enabled?: boolean;
  pendingReview?: boolean;
  url?: string;
}

/** Whether one evaluated script belongs in the answer. */
function matchesListFilters(entry: EvaluatedScript, filters: ListFilters): boolean {
  if (filters.url && !entry.matchesCurrent) return false;
  if (filters.enabled !== undefined && entry.active !== filters.enabled) return false;
  if (
    filters.pendingReview !== undefined &&
    Boolean(entry.script.pendingReview) !== filters.pendingReview
  ) {
    return false;
  }
  if (filters.query) {
    const haystack =
      `${entry.script.name}\n${entry.script.namespace}\n${entry.script.description ?? ''}`.toLowerCase();
    if (!haystack.includes(filters.query)) return false;
  }
  if (filters.tag && !splitTags(entry.metadata).some((value) => value.toLowerCase() === filters.tag)) {
    return false;
  }
  return true;
}

function targetFailure(target: FailedTarget, ref: ScriptTargetRef): CallToolResult {
  if (target.kind === 'ambiguous') {
    return failed({
      code: 'AMBIGUOUS',
      name: ref.name,
      total: target.total,
      candidates: target.candidates,
      message: 'More than one script has this name; retry with id.',
    });
  }
  return failed({
    code: 'INVALID_INPUT',
    message: 'Provide id, or name with an optional namespace.',
  });
}

/**
 * Ids of the given scripts the agent must not switch on: with review on, the
 * decision to enable a pending script is the user's, not the model's.
 */
async function pendingReviewIds(uuids: string[], reviewWrites: boolean): Promise<string[]> {
  if (!reviewWrites) return [];
  const scripts = await Promise.all(uuids.map((uuid) => getScript(uuid)));
  return scripts.flatMap((script) => (script?.pendingReview ? [script.uuid] : []));
}

/** One change to a script's source: the whole file, or anchored replacements. */
type SourceChange =
  | { kind: 'code'; code: string }
  | { kind: 'edits'; edits: Array<{ oldText: string; newText: string }> };

/** Read the change out of the tool input, refusing both and neither. */
function sourceChangeOf(args: {
  code?: string;
  edits?: Array<{ oldText: string; newText: string }>;
}): SourceChange | undefined {
  if (args.code !== undefined && args.edits !== undefined) return undefined;
  if (args.code !== undefined) return { kind: 'code', code: args.code };
  if (args.edits !== undefined) return { kind: 'edits', edits: args.edits };
  return undefined;
}

interface ChangedSource {
  code: string;
  /** Where each anchored replacement landed, for the model's own sanity check. */
  applied?: Array<{ strategy: string; line: number }>;
}

/** Apply the requested change to the script's current source. */
async function changeSource(
  script: UserScript,
  change: SourceChange,
): Promise<{ ok: true; source: ChangedSource } | { ok: false; failure: CallToolResult }> {
  if (change.kind === 'code') return { ok: true, source: { code: change.code } };

  const current = await getScriptWithCode(script.uuid);
  if (!current) return { ok: false, failure: failed({ code: 'NOT_FOUND', id: script.uuid }) };
  const result = applyEdits(current.code, change.edits);
  if (!result.ok) {
    return {
      ok: false,
      failure: failed({
        code: 'EDIT_FAILED',
        index: result.index,
        message: result.error,
        note: 'Nothing was saved.',
      }),
    };
  }
  return {
    ok: true,
    source: {
      code: result.text,
      applied: result.applied.map((edit) => ({ strategy: edit.strategy, line: edit.line })),
    },
  };
}

function reviewRequired(ids: string[]): CallToolResult {
  return failed({
    code: 'REVIEW_REQUIRED',
    ids,
    message:
      'These scripts still need the user\'s review; ask the user to enable them in Lumo Userscripts.',
  });
}

/**
 * Register the tool surface.
 *
 * Read tools are always available; write tools are only registered when the
 * user allowed writes, so the model never sees capabilities it cannot use.
 * Tool names are local; the host prefixes them with the service namespace
 * (`userscripts_*`).
 *
 * Every tool owns one verb: `list` indexes, `get` reads a script and its
 * source, `update` writes a source, `diagnostics` reports the runtime. No tool
 * duplicates another's job, so the model never has to choose between two ways
 * of doing the same thing.
 */
export function registerAgentTools(
  server: McpServer,
  senderId: string | undefined,
  settings: AgentSettings,
): void {
  server.registerTool(
    'list',
    {
      title: 'List userscripts',
      annotations: { readOnlyHint: true, idempotentHint: true },
      description:
        'List userscripts with a compact index row per script. Filter by text, enabled state, review state, tag, or the URL a script must match. Source code is not included; use get for that.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive match on name, namespace or description.'),
        enabled: z.boolean().optional().describe('Only enabled (true) or disabled (false) scripts.'),
        pendingReview: z
          .boolean()
          .optional()
          .describe('Only scripts still awaiting the user\'s review (true) or already reviewed (false).'),
        tag: z.string().optional().describe('Require this @tag value.'),
        url: z.string().optional().describe('Keep only scripts whose @match/@include cover this URL.'),
        includeRemoved: z.boolean().optional().describe('Include scripts in the recycle bin.'),
        offset: z.number().int().min(0).optional().describe('Index of the first row to return.'),
        limit: z.number().int().min(1).max(LIST_PAGE_MAX).optional(),
      },
    },
    (args) =>
      guardedRead(senderId, async () => {
        const limit = args.limit ?? 100;
        const offset = args.offset ?? 0;
        const filters: ListFilters = {
          ...(args.query ? { query: args.query.trim().toLowerCase() } : {}),
          ...(args.tag ? { tag: args.tag.trim().toLowerCase() } : {}),
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
          ...(args.pendingReview !== undefined ? { pendingReview: args.pendingReview } : {}),
          ...(args.url ? { url: args.url } : {}),
        };
        const scripts = await listScripts(args.includeRemoved === true);
        const entries = evaluateScripts(scripts, args.url).filter((entry) =>
          matchesListFilters(entry, filters),
        );

        const page = entries.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
          total: entries.length,
          offset,
          returned: page.length,
          ...(nextOffset < entries.length ? { nextOffset } : {}),
          scripts: page.map((entry) => toSummary(entry.script, entry.metadata)),
        };
      }),
  );

  server.registerTool(
    'get',
    {
      title: 'Get a userscript',
      annotations: { readOnlyHint: true, idempotentHint: true },
      description:
        'Fetch one script by id (uuid) or by name + namespace: the complete source code plus the metablock summary, resource list and runtime state. The source is returned in full; hosts that cap a single response cut it, so page with codeOffset/codeLength from nextOffset when the payload came back truncated.',
      inputSchema: {
        id: z.string().optional().describe('Script uuid from list.'),
        name: z.string().optional().describe('@name, used when id is omitted.'),
        namespace: z.string().optional().describe('@namespace, narrows a name lookup.'),
        codeOffset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('First character of the source to return. Defaults to the whole file.'),
        codeLength: z
          .number()
          .int()
          .min(1)
          .max(CODE_PAGE_MAX)
          .optional()
          .describe('Characters to return. Defaults to the rest of the file.'),
      },
    },
    (args) =>
      guardedRead(senderId, async () => {
        const target = await resolveTarget(args);
        if (target.kind === 'missing') return { found: false };
        if (target.kind !== 'found') return targetFailure(target, args);

        const withCode = await getScriptWithCode(target.script.uuid);
        if (!withCode) return { found: false };
        const resources = await getResources(target.script.uuid);
        const window =
          args.codeOffset === undefined && args.codeLength === undefined
            ? undefined
            : { offset: args.codeOffset ?? 0, length: args.codeLength ?? Number.MAX_SAFE_INTEGER };
        return { found: true, script: toDetail(withCode, resources, window) };
      }),
  );

  server.registerTool(
    'diagnostics',
    {
      title: 'Userscript runtime diagnostics',
      annotations: { readOnlyHint: true, idempotentHint: true },
      description:
        'Report whether the userScripts API is available, registration counts, how many scripts await review, and the scripts that recorded a runtime error. Use when a script is installed but does not run; use get for one script\'s own state.',
      inputSchema: {},
    },
    () =>
      guardedRead(senderId, async () => {
        const availability = await checkUserScriptsAvailable();
        const runtime = getRuntimeStatus();
        const scripts = await listScripts(true);
        const failed = scripts.filter((script) => script.lastError);
        const shown = failed.slice(0, 20);
        return {
          runtime: {
            ...runtime,
            userScriptsAvailable: availability.ok,
            lastError: availability.ok ? runtime.lastError : availability.error,
          },
          counts: {
            total: scripts.length,
            enabled: scripts.filter((script) => script.enabled && !script.removedAt).length,
            removed: scripts.filter((script) => script.removedAt).length,
            pendingReview: scripts.filter((script) => script.pendingReview).length,
            withErrors: failed.length,
          },
          errors: shown.map((script) => ({
            id: script.uuid,
            name: script.name,
            lastError: script.lastError,
          })),
          ...(failed.length > shown.length ? { errorsOmitted: failed.length - shown.length } : {}),
        };
      }),
  );

  if (!settings.allowWrites) return;

  server.registerTool(
    'set_enabled',
    {
      title: 'Enable or disable userscripts',
      annotations: { readOnlyHint: false, idempotentHint: true },
      description:
        'Enable or disable one or more scripts. Scripts that still await the user\'s review cannot be enabled by the agent: the request is refused with REVIEW_REQUIRED.',
      inputSchema: {
        ids: z.array(z.string()).min(1).max(50).describe('Script uuids from list.'),
        enabled: z.boolean(),
      },
    },
    (args) =>
      guardedWrite(senderId, 'set_enabled', args, async (_target, access) => {
        // Disabling is always allowed; only switching a script *on* can approve
        // code the user never saw.
        const blocked = args.enabled
          ? await pendingReviewIds(args.ids, access.settings.reviewWrites)
          : [];
        if (blocked.length > 0) return reviewRequired(blocked);
        const result = await setScriptsEnabled(args.ids, args.enabled);
        return ok({ ok: true, ...result, runtime: getRuntimeStatus() });
      }),
  );

  server.registerTool(
    'create',
    {
      title: 'Create a userscript',
      annotations: { readOnlyHint: false },
      description:
        'Create a new script from complete source, including the ==UserScript== block. @match/@include decide where it runs (omitting both means everywhere), and @grant must list only the privileged APIs the script uses. When review is on, it is saved disabled and marked pendingReview instead of running immediately.',
      inputSchema: {
        code: z.string().min(1).describe('Complete userscript source, including the metadata block.'),
        sourceUrl: z.string().optional().describe('Origin for relative @require/@resource URLs.'),
      },
    },
    (args) =>
      guardedWrite(senderId, 'create', args, async (target, access) => {
        if (args.code.length > CODE_INPUT_MAX) {
          return failed({ code: 'INVALID_INPUT', message: 'Code is too large.' });
        }
        const sourceUrl = args.sourceUrl ?? '';
        const analysis = analyzeScriptCode(args.code, sourceUrl);
        if (!analysis.ok) {
          return failed({
            code: 'INVALID_CODE',
            errors: analysis.errors.map(formatDiagnostic),
            warnings: analysis.warnings.map(formatDiagnostic),
          });
        }
        const review = access.settings.reviewWrites;
        const record = await saveScriptFromCode(null, args.code, sourceUrl, {
          enabled: !review,
          ...(review ? { pendingReview: true } : {}),
        });
        target.uuid = record.uuid;
        return ok({
          ok: true,
          reviewRequired: review,
          script: toSummary(record),
          warnings: analysis.warnings.map(formatDiagnostic),
        });
      }),
  );

  server.registerTool(
    'update',
    {
      title: 'Update a userscript',
      annotations: { readOnlyHint: false },
      description:
        'Change one script. Send the complete replacement source (code), or anchored replacements (edits) for a small change; exactly one of the two. Read the script with get first, and pass expectedCodeHash from get to detect concurrent edits. With review on the result is saved disabled and pendingReview.',
      inputSchema: {
        id: z.string().describe('Script uuid from list or get.'),
        code: z
          .string()
          .min(1)
          .optional()
          .describe('Complete userscript source, including the metadata block.'),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .min(1)
                .describe('Exact text to replace. Include enough context to match once.'),
              newText: z.string().describe('Replacement text.'),
            }),
          )
          .min(1)
          .max(20)
          .optional()
          .describe('Anchored replacements, applied atomically. Cheaper than code for a local change.'),
        expectedCodeHash: z
          .string()
          .optional()
          .describe('codeHash returned by get; rejects the write if the script changed.'),
      },
    },
    (args) =>
      guardedWrite(senderId, 'update', args, async (target, access) => {
        target.uuid = args.id;
        const change = sourceChangeOf(args);
        if (!change) {
          return failed({
            code: 'INVALID_INPUT',
            message: 'Provide code or edits, but not both.',
          });
        }

        const script = await getScript(args.id);
        if (!script) return failed({ code: 'NOT_FOUND', id: args.id });
        if (script.removedAt) {
          return failed({
            code: 'REMOVED',
            id: script.uuid,
            message: 'This script is in the recycle bin; restore it before editing.',
          });
        }
        if (args.expectedCodeHash && script.codeHash !== args.expectedCodeHash) {
          return failed({
            code: 'CONFLICT',
            id: script.uuid,
            currentCodeHash: script.codeHash,
            currentUpdatedAt: script.updatedAt,
          });
        }

        const changed = await changeSource(script, change);
        if (!changed.ok) return changed.failure;
        const { code, applied } = changed.source;
        if (code.length > CODE_INPUT_MAX) {
          return failed({ code: 'INVALID_INPUT', message: 'Code is too large.' });
        }

        const sourceUrl = sourceUrlOf(script);
        const analysis = analyzeScriptCode(code, sourceUrl);
        if (!analysis.ok) {
          return failed({
            code: 'INVALID_CODE',
            errors: analysis.errors.map(formatDiagnostic),
            warnings: analysis.warnings.map(formatDiagnostic),
            note: 'Nothing was saved.',
          });
        }

        // Review means the *user* approves code before it runs, so a write by the
        // agent parks the script exactly where create/install park a new one.
        const review = access.settings.reviewWrites;
        const next = await saveScriptFromCode(
          script.uuid,
          code,
          sourceUrl,
          review ? { enabled: false, pendingReview: true } : {},
        );
        return ok({
          ok: true,
          reviewRequired: review,
          script: toSummary(next),
          ...(applied ? { applied } : {}),
          warnings: analysis.warnings.map(formatDiagnostic),
          effectiveOnNextLoad: next.enabled && !next.removedAt,
        });
      }),
  );

  server.registerTool(
    'install',
    {
      title: 'Install a userscript from a URL',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        'Download and install a userscript from a URL, including @require/@resource files. When review is on, the installed script stays disabled and pendingReview. If name + namespace already exist the install is refused with CONFLICT unless replaceCodeHash is passed.',
      inputSchema: {
        url: z.string().url().describe('Direct .user.js URL or any URL serving a userscript.'),
        replaceCodeHash: z
          .string()
          .optional()
          .describe('codeHash of the installed script you intend to replace, from get.'),
      },
    },
    (args) =>
      guardedWrite(senderId, 'install', args, async (target, access) => {
        const prepared = await prepareInstall({ sourceUrl: args.url, previewResources: false });
        const existingUuid = prepared.summary.existingUuid;
        const existing = typeof existingUuid === 'string' ? await getScript(existingUuid) : undefined;
        if (existing) {
          if (existing.codeHash !== args.replaceCodeHash) {
            await deleteDraft(prepared.token).catch(() => undefined);
            return failed({
              code: 'CONFLICT',
              existing: toSummary(existing),
              message:
                'A script with this name and namespace is already installed. Call get for its codeHash, then retry with replaceCodeHash to overwrite it.',
            });
          }
        } else if (args.replaceCodeHash !== undefined) {
          // A hash for a script that does not exist is a caller mistake, not a
          // request to install: silently creating one would hide the mismatch.
          await deleteDraft(prepared.token).catch(() => undefined);
          return failed({
            code: 'NOT_FOUND',
            message: 'No installed script matches this URL; omit replaceCodeHash to install it.',
          });
        }

        const review = access.settings.reviewWrites;
        const committed = await commitInstall(prepared.token, {
          enabled: !review,
          ...(review ? { pendingReview: true } : {}),
        });
        target.uuid = committed.uuid;
        const script = await getScript(committed.uuid);
        const warnings = Array.isArray(prepared.summary.warnings)
          ? prepared.summary.warnings.map(formatDiagnostic)
          : [];
        return ok({
          ok: true,
          reviewRequired: review,
          updated: committed.updated,
          script: script ? toSummary(script) : null,
          warnings,
        });
      }),
  );

  server.registerTool(
    'delete',
    {
      title: 'Move a userscript to the trash',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      description:
        'Move a script to the recycle bin. Permanent deletion is not available to the agent, and restore brings a trashed script back.',
      inputSchema: {
        id: z.string().describe('Script uuid from list.'),
      },
    },
    (args) =>
      guardedWrite(senderId, 'delete', args, async (target) => {
        target.uuid = args.id;
        const script = await getScript(args.id);
        if (!script) return failed({ code: 'NOT_FOUND', id: args.id });
        if (script.removedAt) {
          return ok({ ok: true, trashed: false, alreadyRemoved: true, id: script.uuid });
        }
        await removeScript(script.uuid);
        return ok({ ok: true, trashed: true, id: script.uuid });
      }),
  );

  server.registerTool(
    'restore',
    {
      title: 'Restore a userscript from the trash',
      annotations: { readOnlyHint: false, idempotentHint: true },
      description:
        'Bring a trashed script back. It returns disabled while it still awaits the user\'s review, and enabled otherwise.',
      inputSchema: {
        id: z.string().describe('Script uuid from list, with includeRemoved true.'),
      },
    },
    (args) =>
      guardedWrite(senderId, 'restore', args, async (target, access) => {
        target.uuid = args.id;
        const script = await getScript(args.id);
        if (!script) return failed({ code: 'NOT_FOUND', id: args.id });
        if (!script.removedAt) {
          return ok({ ok: true, restored: false, alreadyActive: true, id: script.uuid });
        }

        // Restoring a pending script is not an approval: it comes back with the
        // review marker intact and stays switched off until the user decides.
        const mustReview = Boolean(script.pendingReview) && access.settings.reviewWrites;
        await restoreDeletedScript(script.uuid, { enabled: !mustReview });
        const next = await getScript(script.uuid);
        return ok({
          ok: true,
          restored: true,
          reviewRequired: mustReview,
          script: next ? toSummary(next) : null,
          effectiveOnNextLoad: Boolean(next?.enabled),
        });
      }),
  );
}
