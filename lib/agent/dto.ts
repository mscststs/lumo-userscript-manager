import type { ScriptMetadata, StoredResource, UserScript } from '@/types';
import { getMeta, getMetaList, mergeMetadata, splitTags } from '@/lib/script/metadata';
import { byteLength } from '@/lib/script/hash';

/**
 * Model-facing shape of a script.
 *
 * Deliberately much smaller than `UserScript`: the index is what the model
 * needs to choose a target. Source code, resource bodies and GM values are
 * fetched only by `get`, and values are not exposed at all in the read-only
 * build (they routinely contain credentials).
 */
export interface AgentScriptSummary {
  id: string;
  name: string;
  namespace: string;
  version: string;
  description?: string;
  enabled: boolean;
  removed: boolean;
  /** Agent-authored and not yet reviewed/enabled by the user. */
  pendingReview?: boolean;
  tags: string[];
  /** `@match` + `@include`, capped because the index row stays compact. */
  matches: string[];
  /** Rules dropped from `matches` by the cap; `get` returns all of them. */
  matchesOmitted?: number;
  runAt: string;
  injectInto: string;
  /** Source size in bytes. */
  codeSize: number;
  /** Optimistic-concurrency token for `update`. */
  codeHash: string;
  updatedAt: number;
  lastError?: string;
}

export interface AgentScriptDetail extends AgentScriptSummary {
  author?: string;
  homepage?: string;
  origin: string;
  updateUrl?: string;
  antifeature: string[];
  grant: string[];
  connect: string[];
  require: string[];
  resource: string[];
  /** `@match` rules, complete. */
  match: string[];
  /** `@include` rules, complete. */
  include: string[];
  exclude: string[];
  excludeMatch: string[];
  /** User overrides, if any. The effective values are already in the fields above. */
  hasOverrides: boolean;
  resources: Array<{ url: string; name: string; kind: StoredResource['kind']; bytes: number }>;
  /** Full source unless the caller asked for a page. */
  code: string;
  /** Character length of the whole source: the coordinate space of `codeOffset`. */
  codeChars: number;
  codeOffset?: number;
  /** Characters returned in `code`. */
  codeLength?: number;
  codeTruncated?: boolean;
  /** Pass as `codeOffset` to fetch the next page. */
  nextOffset?: number;
  lastRunAt?: number;
  runCount?: number;
  updateState: UserScript['updateState'];
}

const MATCH_LIMIT = 24;

function matchesFor(metadata: ScriptMetadata): { list: string[]; omitted?: number } {
  const all = [...getMetaList(metadata, 'match'), ...getMetaList(metadata, 'include')];
  if (all.length <= MATCH_LIMIT) return { list: all };
  return { list: all.slice(0, MATCH_LIMIT), omitted: all.length - MATCH_LIMIT };
}

export function toSummary(script: UserScript, metadata?: ScriptMetadata): AgentScriptSummary {
  const effective = metadata ?? mergeMetadata(script.metadata, script.selfMetadata);
  const { list: matches, omitted } = matchesFor(effective);
  return {
    id: script.uuid,
    name: script.name,
    namespace: script.namespace,
    version: script.version,
    description: script.description,
    enabled: script.enabled && !script.removedAt,
    removed: Boolean(script.removedAt),
    ...(script.pendingReview ? { pendingReview: true } : {}),
    tags: splitTags(effective),
    matches,
    ...(omitted ? { matchesOmitted: omitted } : {}),
    runAt: script.runAt,
    injectInto: script.injectInto,
    codeSize: script.codeSize,
    codeHash: script.codeHash,
    updatedAt: script.updatedAt,
    ...(script.lastError ? { lastError: script.lastError } : {}),
  };
}

/** The source slice `get` returns, in coordinates the caller can continue from. */
interface CodePage {
  code: string;
  codeChars: number;
  codeOffset?: number;
  codeLength?: number;
  codeTruncated: boolean;
  nextOffset?: number;
}

/**
 * Slice the source.
 *
 * No window means the whole file: `get` is the tool for reading a script, so
 * its default answer must be the script itself. A window is applied only when
 * the caller deliberately pages through a file too large for one response.
 */
function pageOf(code: string, window?: { offset: number; length: number }): CodePage {
  const offset = window ? Math.min(Math.max(window.offset, 0), code.length) : 0;
  const length = window?.length ?? code.length;
  const slice = code.slice(offset, offset + length);
  const end = offset + slice.length;
  const truncated = end < code.length;
  return {
    code: slice,
    codeChars: code.length,
    ...(window ? { codeOffset: offset, codeLength: slice.length } : {}),
    codeTruncated: truncated,
    ...(truncated ? { nextOffset: end } : {}),
  };
}

/** The metablock as the model reads it: tags, lists and the user's overrides. */
function metablockOf(script: UserScript, effective: ScriptMetadata) {
  return {
    author: getMeta(effective, 'author'),
    homepage:
      getMeta(effective, 'homepage') ??
      getMeta(effective, 'homepageurl') ??
      getMeta(effective, 'website') ??
      getMeta(effective, 'source'),
    origin: script.origin,
    updateUrl: script.updateUrl,
    antifeature: effective.antifeature ?? [],
    grant: effective.grant ?? ['none'],
    connect: (effective.connect ?? []).filter(Boolean),
    require: (effective.require ?? []).filter(Boolean),
    resource: (effective.resource ?? [])
      .map((value) => value.trim().split(/\s+/, 1)[0])
      .filter((value): value is string => Boolean(value)),
    match: getMetaList(effective, 'match'),
    include: getMetaList(effective, 'include'),
    exclude: getMetaList(effective, 'exclude'),
    excludeMatch: getMetaList(effective, 'exclude-match'),
    hasOverrides: Boolean(script.selfMetadata && Object.keys(script.selfMetadata).length > 0),
  };
}

/** One script with its source; the detail view `get` answers with. */
export function toDetail(
  script: UserScript & { code: string },
  resources: StoredResource[],
  codeWindow?: { offset: number; length: number },
): AgentScriptDetail {
  const effective = mergeMetadata(script.metadata, script.selfMetadata);
  return {
    ...toSummary(script, effective),
    ...metablockOf(script, effective),
    resources: resources.map((resource) => ({
      url: resource.url,
      name: resource.name,
      kind: resource.kind,
      // `base64` is text, not bytes: 4 characters carry 3 bytes.
      bytes: byteLength(resource.content) + Math.floor(((resource.base64?.length ?? 0) * 3) / 4),
    })),
    ...pageOf(script.code, codeWindow),
    ...(script.lastRunAt ? { lastRunAt: script.lastRunAt } : {}),
    runCount: script.runCount,
    updateState: script.updateState,
  };
}
