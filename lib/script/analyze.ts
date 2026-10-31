import type { ScriptMetadata } from '@/types';
import { parseMetadata, resolveMetadataUrls, splitTags, getMeta, getMetaList } from './metadata';
import { unsupportedGrants } from './grants';
import { byteLength } from './hash';

/**
 * Metablock tags that are parsed and preserved but never executed.
 *
 * The installer warns about these instead of pretending they work; the agent
 * validation tool reports the same list so a model-authored script does not
 * silently lose behaviour after installation.
 */
const UNSUPPORTED_TAGS = [
  'background',
  'crontab',
  'cloudcat',
  'cloudserver',
  'exportvalue',
  'exportcookie',
  'scripturl',
] as const;

/**
 * Static warnings derived from a parsed metablock.
 *
 * Shared by the install review and the agent `validate` tool so the two cannot
 * drift: a script that warns during install must warn during validation.
 */
export function collectMetadataWarnings(
  metadata: ScriptMetadata,
  parsedWarnings: readonly string[] = [],
): string[] {
  const warnings = [...parsedWarnings];

  if (!metadata.match?.length && !metadata.include?.length) {
    warnings.push('No @match or @include rule; the script will run on every page.');
  }
  for (const grant of unsupportedGrants(metadata.grant)) {
    warnings.push(`Unsupported @grant: ${grant}`);
  }
  if (metadata.grant?.includes('unsafeWindow') && metadata['inject-into']?.[0] === 'content') {
    warnings.push('unsafeWindow requires the page world; @inject-into content is ignored.');
  }
  for (const feature of metadata.antifeature ?? []) {
    if (feature.trim()) warnings.push(`@antifeature: ${feature.trim()}`);
  }
  if (metadata['run-in']?.length) {
    warnings.push('@run-in is not supported; the script runs in normal tabs.');
  }
  for (const tag of UNSUPPORTED_TAGS) {
    if (metadata[tag]?.length) warnings.push(`@${tag} is not supported.`);
  }

  return warnings;
}

export interface ScriptAnalysis {
  ok: boolean;
  errors: string[];
  warnings: string[];
  metadata: {
    name: string;
    namespace: string;
    version: string;
    description?: string;
    author?: string;
    homepage?: string;
    match: string[];
    include: string[];
    exclude: string[];
    excludeMatch: string[];
    grant: string[];
    connect: string[];
    require: string[];
    resource: string[];
    runAt?: string;
    injectInto?: string;
    tags: string[];
    antifeature: string[];
  };
  codeSize: number;
}

/**
 * Parse and describe a script without writing anything.
 *
 * `sourceUrl` is used to resolve relative `@require` / `@resource` URLs, exactly
 * as the installer does, so validation matches what would be installed.
 */
export function analyzeScriptCode(code: string, sourceUrl = ''): ScriptAnalysis {
  const parsed = parseMetadata(code);
  const metadata = resolveMetadataUrls(
    { ...parsed.metadata, namespace: parsed.metadata.namespace ?? [''] },
    sourceUrl,
  );

  return {
    ok: parsed.errors.length === 0,
    errors: parsed.errors,
    warnings: collectMetadataWarnings(metadata, parsed.warnings),
    metadata: {
      name: getMeta(metadata, 'name') ?? '',
      namespace: getMeta(metadata, 'namespace') ?? '',
      version: getMeta(metadata, 'version') ?? '',
      description: getMeta(metadata, 'description'),
      author: getMeta(metadata, 'author'),
      homepage:
        getMeta(metadata, 'homepage') ??
        getMeta(metadata, 'homepageurl') ??
        getMeta(metadata, 'website') ??
        getMeta(metadata, 'source'),
      match: getMetaList(metadata, 'match'),
      include: getMetaList(metadata, 'include'),
      exclude: getMetaList(metadata, 'exclude'),
      excludeMatch: getMetaList(metadata, 'exclude-match'),
      grant: metadata.grant ?? ['none'],
      connect: (metadata.connect ?? []).filter(Boolean),
      require: (metadata.require ?? []).filter(Boolean),
      resource: (metadata.resource ?? [])
        .map((value) => value.trim().split(/\s+/, 1)[0])
        .filter((value): value is string => Boolean(value)),
      runAt: getMeta(metadata, 'run-at'),
      injectInto: getMeta(metadata, 'inject-into'),
      tags: splitTags(metadata),
      antifeature: metadata.antifeature ?? [],
    },
    codeSize: byteLength(code),
  };
}
