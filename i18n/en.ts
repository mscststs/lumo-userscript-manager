/**
 * Backwards-compatible type/bundle export.
 *
 * Translations live in `i18n/locales/*.json` so the locale bundles can be
 * code-split. This module stays as the typed entry point tests and non-React
 * callers already import.
 */
import en from './locales/en.json';

export { en };
export type TranslationSchema = typeof en;
