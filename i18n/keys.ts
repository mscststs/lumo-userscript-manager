import type en from './locales/en.json';

/** Every dotted leaf key in the canonical English bundle. */
type Leaves<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object ? `${K}.${Leaves<T[K]>}` : K;
    }[keyof T & string]
  : never;

/**
 * Compile-time union of translation keys.
 *
 * Registries (`labelKey`, `tipKey`, `descriptionKey`) and runtime code→key maps
 * use this type so a typo is a TypeScript error rather than a raw dotted key in
 * the UI. `i18next.d.ts` provides the same check for literal `t('...')` calls.
 */
export type TranslationKey = Leaves<typeof en>;
