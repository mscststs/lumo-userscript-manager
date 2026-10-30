import type { ScriptMetadata } from '@/types';

const META_BLOCK_RE = /\/\/[ \t]*==UserScript==([\s\S]*?)\/\/[ \t]*==\/UserScript==/m;
const META_LINE_RE = /^[ \t]*\/\/[ \t]*@([^\s]+)[ \t]*(.*)$/;

export interface ParsedMetadata {
  metadata: ScriptMetadata;
  metaStr: string;
  errors: string[];
  warnings: string[];
}

/** Split `name url` declarations used by `@resource`. */
export function parseResourceDeclaration(value: string): { name: string; url: string } | null {
  const match = value.trim().match(/^(\S+)\s+(.+)$/);
  return match ? { name: match[1]!, url: match[2]!.trim() } : null;
}

/** Parse the `==UserScript==` block. Never throws; problems are returned. */
export function parseMetadata(code: string): ParsedMetadata {
  const errors: string[] = [];
  const warnings: string[] = [];
  const metadata: ScriptMetadata = Object.create(null);
  const block = META_BLOCK_RE.exec(code);

  if (!block) {
    return {
      metadata,
      metaStr: '',
      errors: ['No ==UserScript== metadata block found.'],
      warnings,
    };
  }

  const metaStr = block[0];
  const lines = block[1]!.split(/\r?\n/);
  for (const line of lines) {
    const match = META_LINE_RE.exec(line);
    if (!match) continue;
    const rawTag = match[1]!;
    const tag = rawTag.toLowerCase();
    if (tag === '__proto__' || tag === 'constructor' || tag === 'prototype') continue;
    const value = match[2]!.trim();
    const values = metadata[tag] ?? (metadata[tag] = []);
    values.push(value);
  }

  if (!metadata.name?.[0]) errors.push('@name is required.');
  if (metadata.namespace === undefined) metadata.namespace = [''];

  if (metadata.grant?.includes('none') && metadata.grant.length > 1) {
    metadata.grant = ['none'];
    warnings.push('@grant none ignores the other @grant entries.');
  }

  // A malformed match pattern is a hard error: silently dropping it makes a
  // script appear installed but never run.
  for (const pattern of metadata.match ?? []) {
    if (!isValidMatchPattern(pattern)) {
      errors.push(`Invalid @match pattern: ${pattern}`);
    }
  }
  for (const pattern of metadata['exclude-match'] ?? []) {
    if (!isValidMatchPattern(pattern)) {
      errors.push(`Invalid @exclude-match pattern: ${pattern}`);
    }
  }

  const resourceNames = new Set<string>();
  for (const value of metadata.resource ?? []) {
    const resource = parseResourceDeclaration(value);
    if (!resource) {
      warnings.push(`Invalid @resource declaration: ${value}`);
    } else if (resourceNames.has(resource.name)) {
      warnings.push(`Duplicate @resource name: ${resource.name}`);
    } else {
      resourceNames.add(resource.name);
    }
  }

  const runAt = metadata['run-at']?.[0];
  if (
    runAt &&
    ![
      'document-start',
      'document-body',
      'document-end',
      'document-idle',
      'context-menu',
      'early-start',
    ].includes(runAt)
  ) {
    warnings.push(`Unknown @run-at value: ${runAt}`);
  }
  const injectInto = metadata['inject-into']?.[0];
  if (injectInto && !['auto', 'page', 'content'].includes(injectInto)) {
    warnings.push(`Unknown @inject-into value: ${injectInto}`);
  }

  return { metadata, metaStr, errors, warnings };
}


/** Resolve metadata URL values against the URL the script was installed from. */
export function resolveMetadataUrls(metadata: ScriptMetadata, baseUrl?: string): ScriptMetadata {
  if (!baseUrl) return { ...metadata };
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { ...metadata };
  }
  const resolve = (value: string): string => {
    try {
      return new URL(value, base).toString();
    } catch {
      return value;
    }
  };
  const resolved: ScriptMetadata = { ...metadata };
  for (const key of ['require', 'require-css']) {
    if (resolved[key]) resolved[key] = resolved[key]!.map(resolve);
  }
  if (resolved.resource) {
    resolved.resource = resolved.resource.map((value) => {
      const resource = parseResourceDeclaration(value);
      return resource ? `${resource.name} ${resolve(resource.url)}` : value;
    });
  }
  for (const key of [
    'icon',
    'iconurl',
    'icon64',
    'icon64url',
    'defaulticon',
    'homepage',
    'homepageurl',
    'website',
    'supporturl',
    'source',
    'updateurl',
    'downloadurl',
  ]) {
    if (resolved[key]?.[0]) resolved[key] = [resolve(resolved[key]![0]!)];
  }
  return resolved;
}

/** Merge user overrides over the script's own metablock. */
export function mergeMetadata(base: ScriptMetadata, overrides?: ScriptMetadata): ScriptMetadata {
  if (!overrides) return { ...base };
  const merged: ScriptMetadata = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = [...value];
  }
  return merged;
}

export function getMeta(metadata: ScriptMetadata, key: string): string | undefined {
  return metadata[key]?.[0];
}

export function getMetaList(metadata: ScriptMetadata, key: string): string[] {
  return metadata[key] ?? [];
}

/**
 * Presence check for bare flags (`@noframes`, `@unwrap`, `@top-level-await`).
 *
 * Length, not key presence: an override written as `[]` means "remove this tag",
 * which is the only way the UI can turn a flag off without rewriting the source.
 * A parsed tag always carries at least one (possibly empty) value, so real
 * metablocks are unaffected.
 */
export function hasMeta(metadata: ScriptMetadata, key: string): boolean {
  return (metadata[key]?.length ?? 0) > 0;
}

/** Resolve localized `@name:zh-CN` / `@description:en` values. */
export function getLocalizedMeta(
  metadata: ScriptMetadata,
  key: string,
  language: string,
): string | undefined {
  const normalized = language.toLowerCase();
  const base = normalized.split('-')[0] ?? normalized;
  return (
    metadata[`${key}:${normalized}`]?.[0] ??
    (base !== normalized ? metadata[`${key}:${base}`]?.[0] : undefined) ??
    metadata[key]?.[0]
  );
}

export function scriptDisplayName(metadata: ScriptMetadata, language = 'en'): string {
  return (
    getLocalizedMeta(metadata, 'name', language) ??
    getMeta(metadata, 'name') ??
    'Untitled script'
  );
}

export function splitTags(metadata: ScriptMetadata): string[] {
  const tags = new Set<string>();
  for (const raw of metadata.tag ?? []) {
    for (const tag of raw.split(/[\s,，]+/)) {
      if (tag) tags.add(tag);
    }
  }
  return [...tags];
}

export function metadataRequires(metadata: ScriptMetadata): string[] {
  return metadata.require ?? [];
}

export function metadataRequiresCss(metadata: ScriptMetadata): string[] {
  return metadata['require-css'] ?? [];
}

export function metadataResources(metadata: ScriptMetadata): { name: string; url: string }[] {
  return (metadata.resource ?? [])
    .map(parseResourceDeclaration)
    .filter((item): item is { name: string; url: string } => item !== null);
}

/** `@match` patterns use Chrome's match-pattern grammar; this is the validator. */
export function isValidMatchPattern(pattern: string): boolean {
  if (pattern === '<all_urls>') return true;
  const match = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/);
  if (!match) return false;
  const [, scheme, host, path] = match;
  if (!scheme || host === undefined || !path) return false;
  if (scheme === 'file') return host === '' && path.startsWith('/');
  if (!host) return false;
  if (host === '*') return true;
  if (host.startsWith('*.')) {
    return /^[^*/]+$/.test(host.slice(2));
  }
  return !host.includes('*');
}
