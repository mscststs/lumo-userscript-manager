import type { LanguagePreference } from '@/i18n/locales';
import { normalizeLanguage as normalize } from '@/i18n/locales';

/**
 * Compatibility surface for the language preference.
 *
 * The registry itself lives in `i18n/locales.ts` so the background service
 * worker, the picker, the manifest generator and i18next all read the same
 * source. This module keeps the old import path working for callers that only
 * need the default or a normalised value.
 */
export const DEFAULT_LANGUAGE = 'auto' as const satisfies LanguagePreference;

export function normalizeLanguage(raw: unknown): LanguagePreference {
  return normalize(raw);
}
