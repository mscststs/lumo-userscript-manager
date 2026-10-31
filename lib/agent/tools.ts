import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AgentSettings, ScriptMetadata, UserScript } from '@/types';
import {
  findByNameNamespace,
  getResources,
  getScript,
  getScriptWithCode,
  listScripts,
} from '@/lib/db';
import {
  commitInstall,
  prepareInstall,
  removeScript,
  saveScriptFromCode,
  setScriptsEnabled,
  updateSelfMetadata,
} from '@/lib/background/scripts';
import { checkUserScriptsAvailable, getRuntimeStatus } from '@/lib/background/registry';
import { evaluateScripts } from '@/lib/background/matching';
import { analyzeScriptCode } from '@/lib/script/analyze';
import { applyEdits } from '@/lib/script/edit';
import { splitTags } from '@/lib/script/metadata';
import { resolveAgentAccess, type AgentAccess } from './policy';
import { recordAgentAudit } from './audit';
import { consumeWrite } from './rate-limit';
import { toDetail, toSummary } from './dto';

/** Default slice of source code returned by `get`. */
const CODE_WINDOW = 64 * 1024;
const CODE_WINDOW_MAX = 128 * 1024;
/** Refuse to parse or store arbitrarily large agent input. */
const CODE_INPUT_MAX = 5 * 1024 * 1024;

const INTRO =
  'Lumo Userscripts manages the userscripts installed in this browser. A script is identified by its namespace + name and by its uuid (the "id" field).';

const READ_ONLY =
  'This endpoint is read-only: you can search, inspect and diagnose scripts, but you cannot modify them.';

const WRITE = `You can also create, edit, enable/disable, install and trash scripts.
- Prefer edit for small changes: pass {oldText,newText} anchors; each must match exactly once and the batch is atomic.
- Use update only to replace the whole source or metadata overrides.
- Pass expectedCodeHash from get to edit/update; a mismatch means the user changed the script.
- create/update/edit re-validate the metadata block and reject invalid input with the exact errors.
- @match / @include decide where a script runs; omitting both means everywhere.
- @grant lists privileged APIs; do not add grants the script does not use.`;

const FINDING = `Finding scripts:
- Call list first. Pass url to answer "which scripts run on this page"; without url, list returns the library.
- Call get only when you need details. Source code is large: request it with includeCode and page through big files with codeOffset/codeLength.`;

const RUNNING = `Running scripts:
- set_enabled toggles scripts; enabling a pending script counts as reviewing it.
- Editing an enabled script takes effect on the next page load.
- delete moves a script to the trash; permanent deletion is not available.`;

const DIAGNOSING = `Diagnosing:
- Call diagnostics when a script "does not work": it reports whether chrome.userScripts is available, registration counts, and runtime errors.`;

const REVIEW_POLICY =
  'The user has enabled review: new scripts are created disabled and marked pendingReview. Tell the user to review and enable them in Lumo Userscripts, and do not claim a new script is running.';

/** Server instructions, shaped by the policy the host connected with. */
export function buildAgentInstructions(settings: AgentSettings): string {
  return [
    INTRO,
    settings.allowWrites ? WRITE : READ_ONLY,
    FINDING,
    settings.allowWrites ? RUNNING : '',
    DIAGNOSING,
    settings.allowWrites && settings.reviewWrites ? REVIEW_POLICY : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isRecord(payload) ? { structuredContent: payload } : {}),
  };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * A business failure the model can act on (conflict, not found, rate limit).
 * Distinct from protocol errors: it is a successful call with `isError`, so the
 * reason reaches the model instead of aborting the MCP request.
 */
function failed(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
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

function guardedRead(
  senderId: string | undefined,
  run: () => Promise<unknown>,
): Promise<CallToolResult> {
  return requireAccess(senderId, false)
    .then(run)
    .then(ok, (error) => fail(messageOf(error)));
}

/**
 * Gate, rate-limit and audit one write call.
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

  if (!consumeWrite(senderId)) {
    await recordAgentAudit({ tool, senderId, args, result: 'error', message: 'RATE_LIMITED' });
    return failed({
      code: 'RATE_LIMITED',
      message: 'Too many write calls; retry in a minute.',
    });
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
    return fail(messageOf(error));
  }
}

function resolveScript(
  id: string | undefined,
  name: string | undefined,
  namespace: string | undefined,
): Promise<UserScript | undefined> {
  if (id) return getScript(id);
  if (name) return findByNameNamespace(name, namespace ?? '', true);
  return Promise.resolve(undefined);
}

/**
 * Register the tool surface.
 *
 * Read tools are always available; write tools are only registered when the
 * user allowed writes, so the model never sees capabilities it cannot use.
 * Tool names are local; the host prefixes them with the service namespace
 * (`userscripts_*`).
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
        'List userscripts with a compact index row per script. Filter by text, enabled state, tag, or the URL a script must match. Source code is not included.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive match on name, namespace or description.'),
        enabled: z.boolean().optional().describe('Only enabled (true) or disabled (false) scripts.'),
        tag: z.string().optional().describe('Require this @tag value.'),
        url: z.string().optional().describe('Keep only scripts whose @match/@include cover this URL.'),
        includeRemoved: z.boolean().optional().describe('Include scripts in the recycle bin.'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    (args) =>
      guardedRead(senderId, async () => {
        const scripts = await listScripts(args.includeRemoved === true);
        const query = args.query?.trim().toLowerCase();
        const tag = args.tag?.trim().toLowerCase();
        const limit = args.limit ?? 100;
        const entries = evaluateScripts(scripts, args.url).filter((entry) => {
          if (args.url && !entry.matchesCurrent) return false;
          if (args.enabled !== undefined && entry.active !== args.enabled) return false;
          if (query) {
            const haystack =
              `${entry.script.name}\n${entry.script.namespace}\n${entry.script.description ?? ''}`.toLowerCase();
            if (!haystack.includes(query)) return false;
          }
          if (tag && !splitTags(entry.metadata).some((value) => value.toLowerCase() === tag)) {
            return false;
          }
          return true;
        });

        return {
          total: entries.length,
          returned: Math.min(limit, entries.length),
          scripts: entries
            .slice(0, limit)
            .map((entry) => toSummary(entry.script, entry.metadata)),
        };
      }),
  );

  server.registerTool(
    'get',
    {
      title: 'Get a userscript',
      annotations: { readOnlyHint: true, idempotentHint: true },
      description:
        'Fetch one script by id (uuid) or by name + namespace, including its metablock summary and resource list. Source code is omitted unless includeCode is true; large code can be paged with codeOffset/codeLength.',
      inputSchema: {
        id: z.string().optional().describe('Script uuid from list.'),
        name: z.string().optional().describe('@name, used when id is omitted.'),
        namespace: z.string().optional().describe('@namespace, used with name.'),
        includeCode: z.boolean().optional(),
        codeOffset: z.number().int().min(0).optional(),
        codeLength: z.number().int().min(1).max(CODE_WINDOW_MAX).optional(),
      },
    },
    (args) =>
      guardedRead(senderId, async () => {
        const script = await resolveScript(args.id, args.name, args.namespace);
        if (!script) return { found: false };
        const withCode = await getScriptWithCode(script.uuid);
        if (!withCode) return { found: false };
        const resources = await getResources(script.uuid);
        const window = args.includeCode
          ? {
              offset: args.codeOffset ?? 0,
              length: args.codeLength ?? CODE_WINDOW,
            }
          : undefined;
        return { found: true, script: toDetail(withCode, resources, window) };
      }),
  );

  server.registerTool(
    'diagnostics',
    {
      title: 'Userscript runtime diagnostics',
      annotations: { readOnlyHint: true, idempotentHint: true },
      description:
        'Report whether chrome.userScripts is available, registration counts, and scripts that recorded a runtime error. Use when a script is installed but does not run.',
      inputSchema: {
        id: z.string().optional().describe('Include update/runtime state for one script.'),
      },
    },
    (args) =>
      guardedRead(senderId, async () => {
        const availability = await checkUserScriptsAvailable();
        const runtime = getRuntimeStatus();
        const scripts = await listScripts(true);
        const payload: Record<string, unknown> = {
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
            withErrors: scripts.filter((script) => script.lastError).length,
          },
          errors: scripts
            .filter((script) => script.lastError)
            .slice(0, 20)
            .map((script) => ({
              id: script.uuid,
              name: script.name,
              lastError: script.lastError,
            })),
        };
        if (args.id) {
          const script = scripts.find((entry) => entry.uuid === args.id);
          payload.script = script
            ? {
                id: script.uuid,
                name: script.name,
                enabled: script.enabled,
                removed: Boolean(script.removedAt),
                pendingReview: Boolean(script.pendingReview),
                updateState: script.updateState,
                lastRunAt: script.lastRunAt,
                runCount: script.runCount,
                lastError: script.lastError,
              }
            : null;
        }
        return payload;
      }),
  );

  if (!settings.allowWrites) return;

  server.registerTool(
    'set_enabled',
    {
      title: 'Enable or disable userscripts',
      annotations: { readOnlyHint: false, idempotentHint: true },
      description:
        'Enable or disable one or more scripts. Enabling a script that is pending review counts as reviewing it.',
      inputSchema: {
        ids: z.array(z.string()).min(1).max(50).describe('Script uuids from list.'),
        enabled: z.boolean(),
      },
    },
    (args) =>
      guardedWrite(senderId, 'set_enabled', args, async () => {
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
        'Create a new script from complete source, including the ==UserScript== block. When review is on, it is saved disabled and marked pendingReview instead of running immediately.',
      inputSchema: {
        code: z.string().min(1).describe('Complete userscript source, including the metadata block.'),
        sourceUrl: z.string().optional().describe('Origin for relative @require/@resource URLs.'),
        enabled: z
          .boolean()
          .optional()
          .describe('Requested initial state; ignored while review is on.'),
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
            errors: analysis.errors,
            warnings: analysis.warnings,
          });
        }
        const review = access.settings.reviewWrites;
        const record = await saveScriptFromCode(null, args.code, sourceUrl, {
          enabled: review ? false : (args.enabled ?? true),
          ...(review ? { pendingReview: true } : {}),
        });
        target.uuid = record.uuid;
        return ok({
          ok: true,
          reviewRequired: review,
          script: toSummary(record),
          warnings: analysis.warnings,
        });
      }),
  );

  server.registerTool(
    'edit',
    {
      title: 'Edit a userscript',
      annotations: { readOnlyHint: false },
      description:
        'Apply small anchored replacements to an existing script. Each oldText must match exactly once and the whole batch is atomic. The metadata block is re-validated after the edits. Prefer this over update for small changes.',
      inputSchema: {
        id: z.string().describe('Script uuid from list or get.'),
        edits: z
          .array(
            z.object({
              oldText: z.string().min(1).describe('Exact text to replace. Include enough context to match once.'),
              newText: z.string().describe('Replacement text.'),
            }),
          )
          .min(1)
          .max(20),
        expectedCodeHash: z
          .string()
          .optional()
          .describe('codeHash returned by get; rejects the edit if the script changed.'),
      },
    },
    (args) =>
      guardedWrite(senderId, 'edit', args, async (target) => {
        target.uuid = args.id;
        const script = await getScript(args.id);
        if (!script) return failed({ code: 'NOT_FOUND', id: args.id });
        if (args.expectedCodeHash && script.codeHash !== args.expectedCodeHash) {
          return failed({
            code: 'CONFLICT',
            id: script.uuid,
            currentCodeHash: script.codeHash,
            currentUpdatedAt: script.updatedAt,
          });
        }
        const withCode = await getScriptWithCode(script.uuid);
        if (!withCode) return failed({ code: 'NOT_FOUND', id: args.id });

        const result = applyEdits(withCode.code, args.edits);
        if (!result.ok) {
          return failed({ code: 'EDIT_FAILED', index: result.index, message: result.error });
        }
        if (result.text.length > CODE_INPUT_MAX) {
          return failed({ code: 'INVALID_INPUT', message: 'Code is too large.' });
        }

        const sourceUrl = script.origin || script.downloadUrl || '';
        const analysis = analyzeScriptCode(result.text, sourceUrl);
        if (!analysis.ok) {
          return failed({
            code: 'INVALID_CODE',
            errors: analysis.errors,
            warnings: analysis.warnings,
            note: 'Nothing was saved.',
          });
        }

        const next = await saveScriptFromCode(script.uuid, result.text, sourceUrl);
        return ok({
          ok: true,
          script: toSummary(next),
          applied: result.applied.map((applied) => ({
            strategy: applied.strategy,
            line: applied.line,
          })),
          warnings: analysis.warnings,
          effectiveOnNextLoad: next.enabled && !next.removedAt,
        });
      }),
  );

  server.registerTool(
    'update',
    {
      title: 'Update a userscript',
      annotations: { readOnlyHint: false },
      description:
        'Replace a script\'s whole source and/or metadata overrides. Prefer edit for small changes. Pass expectedCodeHash from get to detect concurrent edits.',
      inputSchema: {
        id: z.string().describe('Script uuid from list or get.'),
        code: z
          .string()
          .optional()
          .describe('Complete userscript source, including the metadata block.'),
        selfMetadata: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe('User overrides for individual @tags, merged over the code metadata.'),
        expectedCodeHash: z
          .string()
          .optional()
          .describe('codeHash returned by get; rejects the write if the script changed.'),
      },
    },
    (args) =>
      guardedWrite(senderId, 'update', args, async (target) => {
        target.uuid = args.id;
        const script = await getScript(args.id);
        if (!script) return failed({ code: 'NOT_FOUND', id: args.id });
        if (args.expectedCodeHash && script.codeHash !== args.expectedCodeHash) {
          return failed({
            code: 'CONFLICT',
            id: script.uuid,
            currentCodeHash: script.codeHash,
            currentUpdatedAt: script.updatedAt,
          });
        }
        if (!args.code && !args.selfMetadata) {
          return failed({
            code: 'INVALID_INPUT',
            message: 'Provide code, selfMetadata, or both.',
          });
        }
        if (args.code && args.code.length > CODE_INPUT_MAX) {
          return failed({ code: 'INVALID_INPUT', message: 'Code is too large.' });
        }

        let next: UserScript = script;
        const warnings: string[] = [];
        if (args.code) {
          const sourceUrl = script.origin || script.downloadUrl || '';
          const analysis = analyzeScriptCode(args.code, sourceUrl);
          if (!analysis.ok) {
            return failed({
              code: 'INVALID_CODE',
              errors: analysis.errors,
              warnings: analysis.warnings,
            });
          }
          warnings.push(...analysis.warnings);
          next = await saveScriptFromCode(script.uuid, args.code, sourceUrl);
        }
        if (args.selfMetadata) {
          next = await updateSelfMetadata(script.uuid, args.selfMetadata as ScriptMetadata);
        }
        return ok({
          ok: true,
          script: toSummary(next),
          warnings,
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
        'Download and install a userscript from a URL, including @require/@resource files. When review is on, the installed script stays disabled and pendingReview. Updates an existing script when name + namespace match.',
      inputSchema: {
        url: z.string().url().describe('Direct .user.js URL or any URL serving a userscript.'),
        enabled: z
          .boolean()
          .optional()
          .describe('Requested initial state; ignored while review is on.'),
      },
    },
    (args) =>
      guardedWrite(senderId, 'install', args, async (target, access) => {
        const review = access.settings.reviewWrites;
        const prepared = await prepareInstall({ sourceUrl: args.url });
        const committed = await commitInstall(prepared.token, {
          enabled: review ? false : (args.enabled ?? true),
          ...(review ? { pendingReview: true } : {}),
        });
        target.uuid = committed.uuid;
        const script = await getScript(committed.uuid);
        const warnings = Array.isArray(prepared.summary.warnings)
          ? prepared.summary.warnings
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
        'Move a script to the recycle bin. Permanent deletion is not available to the agent.',
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
}
