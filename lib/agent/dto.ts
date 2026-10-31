import type { ScriptMetadata, StoredResource, UserScript } from '@/types';
import { getMeta, getMetaList, mergeMetadata, splitTags } from '@/lib/script/metadata';

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
  matches: string[];
  runAt: string;
  injectInto: string;
  codeSize: number;
  /** Optimistic-concurrency token for `update`. */
  codeHash: string;
  updatedAt: number;
  lastError?: string;
}

export interface AgentScriptDetail extends AgentScriptSummary {
  author?: string;
  homepage?: string;
  antifeature: string[];
  grant: string[];
  connect: string[];
  require: string[];
  resource: string[];
  exclude: string[];
  excludeMatch: string[];
  /** User overrides, if any. The effective values are already in the fields above. */
  hasOverrides: boolean;
  resources: Array<{ url: string; name: string; kind: StoredResource['kind']; size: number }>;
  code?: string;
  codeOffset?: number;
  codeSize: number;
  codeTruncated?: boolean;
}

const MATCH_LIMIT = 24;

function matchesFor(metadata: ScriptMetadata): string[] {
  return [...getMetaList(metadata, 'match'), ...getMetaList(metadata, 'include')].slice(
    0,
    MATCH_LIMIT,
  );
}

export function toSummary(script: UserScript, metadata?: ScriptMetadata): AgentScriptSummary {
  const effective = metadata ?? mergeMetadata(script.metadata, script.selfMetadata);
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
    matches: matchesFor(effective),
    runAt: script.runAt,
    injectInto: script.injectInto,
    codeSize: script.codeSize,
    codeHash: script.codeHash,
    updatedAt: script.updatedAt,
    ...(script.lastError ? { lastError: script.lastError } : {}),
  };
}

export function toDetail(
  script: UserScript & { code: string },
  resources: StoredResource[],
  codeWindow?: { offset: number; length: number },
): AgentScriptDetail {
  const effective = mergeMetadata(script.metadata, script.selfMetadata);
  const base = toSummary(script, effective);
  const code = script.code;
  const window = codeWindow ?? { offset: 0, length: code.length };
  const slice = code.slice(window.offset, window.offset + window.length);

  return {
    ...base,
    author: getMeta(effective, 'author'),
    homepage:
      getMeta(effective, 'homepage') ??
      getMeta(effective, 'homepageurl') ??
      getMeta(effective, 'website') ??
      getMeta(effective, 'source'),
    antifeature: effective.antifeature ?? [],
    grant: effective.grant ?? ['none'],
    connect: (effective.connect ?? []).filter(Boolean),
    require: (effective.require ?? []).filter(Boolean),
    resource: (effective.resource ?? [])
      .map((value) => value.trim().split(/\s+/, 1)[0])
      .filter((value): value is string => Boolean(value)),
    exclude: getMetaList(effective, 'exclude'),
    excludeMatch: getMetaList(effective, 'exclude-match'),
    hasOverrides: Boolean(script.selfMetadata && Object.keys(script.selfMetadata).length > 0),
    resources: resources.map((resource) => ({
      url: resource.url,
      name: resource.name,
      kind: resource.kind,
      size: resource.content.length + (resource.base64?.length ?? 0),
    })),
    ...(codeWindow
      ? {
          code: slice,
          codeOffset: window.offset,
          codeTruncated: window.offset + slice.length < code.length,
        }
      : {}),
  };
}
