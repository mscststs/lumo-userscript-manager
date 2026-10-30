import type { Language } from '@/types';

/**
 * Language registry — the single source of truth for selectable UI languages.
 *
 * Kept free of React, i18next and storage imports so the storage schema can
 * normalise a persisted value without pulling the whole i18n runtime into the
 * service worker.
 */
export const LANGUAGES: { value: Language; labelKey: string }[] = [
  { value: 'auto', labelKey: 'options.appearance.languageAuto' },
  { value: 'en', labelKey: 'options.appearance.languageEn' },
  { value: 'zh', labelKey: 'options.appearance.languageZh' },
];

export const DEFAULT_LANGUAGE: Language = 'auto';

const VALID = new Set<Language>(LANGUAGES.map((item) => item.value));

export function normalizeLanguage(raw: unknown): Language {
  return typeof raw === 'string' && VALID.has(raw as Language)
    ? (raw as Language)
    : DEFAULT_LANGUAGE;
}
