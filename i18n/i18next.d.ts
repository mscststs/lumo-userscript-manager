import 'i18next';
import type en from './locales/en.json';

/**
 * Compile-time contract for static translation keys.
 *
 * `en.json` is the canonical schema; every `t('...')` literal is checked against
 * it. Dynamic lookups are routed through explicit key maps in `lib/i18n-keys.ts`
 * so a typo cannot silently render a raw dotted key.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof en;
    };
  }
}
