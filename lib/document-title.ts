import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TranslationKey } from '@/i18n/keys';

/** Product wordmark. Deliberately untranslated, like the browser UI name. */
export const WORDMARK = 'Lumo Userscripts';

/**
 * Keep the tab title in sync with the active language and route.
 *
 * `<title>` in the HTML shell is English by necessity (it is static), so every
 * extension page replaces it once the stored language is known. A tab that
 * says "Settings" under a Chinese UI is the same class of leak as an untranslated
 * button.
 */
export function useDocumentTitle(key?: TranslationKey): void {
  const { t, i18n } = useTranslation();
  useEffect(() => {
    document.title = key ? `${t(key)} — ${WORDMARK}` : WORDMARK;
  }, [key, t, i18n.language]);
}

/** Non-hook variant for bootstrap code that runs before React mounts. */
export function setDocumentTitle(title: string): void {
  if (typeof document !== 'undefined') document.title = title;
}
