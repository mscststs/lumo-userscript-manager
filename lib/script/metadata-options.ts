import type { ScriptInjectInto, ScriptRunAt } from '@/types';

/**
 * Vocabulary shared by every surface that names a `@run-at` / `@inject-into`
 * value.
 *
 * One list, three consumers: the settings defaults (a subset), the metadata
 * override selects, and the read-only info rows. `document-start` must read the
 * same in all three, and the raw value must be shown next to the label — the
 * user is the one who has to write it in a metablock.
 */
export interface MetadataOption<T extends string> {
  value: T;
  /** Translation key of the human label. The raw value is rendered beside it. */
  labelKey: string;
}

export const RUN_AT_OPTIONS: MetadataOption<ScriptRunAt>[] = [
  { value: 'document-start', labelKey: 'metadata.runAt.document-start' },
  { value: 'document-body', labelKey: 'metadata.runAt.document-body' },
  { value: 'document-end', labelKey: 'metadata.runAt.document-end' },
  { value: 'document-idle', labelKey: 'metadata.runAt.document-idle' },
  { value: 'context-menu', labelKey: 'metadata.runAt.context-menu' },
  { value: 'early-start', labelKey: 'metadata.runAt.early-start' },
];

export const INJECT_INTO_OPTIONS: MetadataOption<ScriptInjectInto>[] = [
  { value: 'auto', labelKey: 'metadata.injectInto.auto' },
  { value: 'page', labelKey: 'metadata.injectInto.page' },
  { value: 'content', labelKey: 'metadata.injectInto.content' },
];

/** Values the *global default* setting offers (subset of `@run-at`). */
export const DEFAULT_RUN_AT_VALUES: ScriptRunAt[] = [
  'document-idle',
  'document-end',
  'document-start',
];
