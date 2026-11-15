import type { TranslationKey } from '@/i18n/keys';

/**
 * A metablock/installer finding, separate from its rendered sentence.
 *
 * `message` is the English technical form the agent tools and logs use;
 * `code` + `params` are what the UI renders through `diagnostics.*`.
 */
export type DiagnosticCode =
  | 'metadata.blockMissing'
  | 'metadata.nameRequired'
  | 'metadata.matchInvalid'
  | 'metadata.excludeMatchInvalid'
  | 'metadata.grantNoneIgnoresOthers'
  | 'metadata.resourceInvalid'
  | 'metadata.resourceDuplicate'
  | 'metadata.runAtUnknown'
  | 'metadata.injectIntoUnknown'
  | 'metadata.unsupportedGrant'
  | 'metadata.unsafeWindowPageWorld'
  | 'metadata.antifeature'
  | 'metadata.runInUnsupported'
  | 'metadata.unsupportedTag'
  | 'metadata.noMatch';

export const DIAGNOSTIC_KEYS: Record<DiagnosticCode, TranslationKey> = {
  'metadata.blockMissing': 'diagnostics.metadata.blockMissing',
  'metadata.nameRequired': 'diagnostics.metadata.nameRequired',
  'metadata.matchInvalid': 'diagnostics.metadata.matchInvalid',
  'metadata.excludeMatchInvalid': 'diagnostics.metadata.excludeMatchInvalid',
  'metadata.grantNoneIgnoresOthers': 'diagnostics.metadata.grantNoneIgnoresOthers',
  'metadata.resourceInvalid': 'diagnostics.metadata.resourceInvalid',
  'metadata.resourceDuplicate': 'diagnostics.metadata.resourceDuplicate',
  'metadata.runAtUnknown': 'diagnostics.metadata.runAtUnknown',
  'metadata.injectIntoUnknown': 'diagnostics.metadata.injectIntoUnknown',
  'metadata.unsupportedGrant': 'diagnostics.metadata.unsupportedGrant',
  'metadata.unsafeWindowPageWorld': 'diagnostics.metadata.unsafeWindowPageWorld',
  'metadata.antifeature': 'diagnostics.metadata.antifeature',
  'metadata.runInUnsupported': 'diagnostics.metadata.runInUnsupported',
  'metadata.unsupportedTag': 'diagnostics.metadata.unsupportedTag',
  'metadata.noMatch': 'diagnostics.metadata.noMatch',
};

export interface Diagnostic {
  code: DiagnosticCode;
  params?: Record<string, string | number>;
  /** English technical form, for the agent and log fallbacks. */
  message: string;
}

export function diagnostic(
  code: DiagnosticCode,
  message: string,
  params?: Record<string, string | number>,
): Diagnostic {
  return { code, message, params };
}

/** Technical form for non-React contexts (agent tools, thrown errors). */
export function formatDiagnostic(item: Diagnostic): string {
  return item.message;
}

export function formatDiagnostics(items: readonly Diagnostic[]): string {
  return items.map(formatDiagnostic).join('\n');
}
