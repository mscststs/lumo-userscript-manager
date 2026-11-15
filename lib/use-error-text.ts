import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { AppError, ERROR_KEYS } from './errors';

/**
 * Turn a caught error into a sentence in the active language.
 *
 * `AppError` carries a stable code; everything else (a raw browser error, a
 * `TypeError`) has no translation and falls back to its own message. Keeping
 * this in a hook rather than on the error class leaves `lib/errors.ts` free of
 * React, so the service worker can import it.
 */
export function useErrorText(): (error: unknown) => string {
  const { t } = useTranslation();
  return useCallback((error: unknown): string => {
    if (error instanceof AppError) {
      const headline = t(ERROR_KEYS[error.code], error.params);
      const detail = error.detail?.trim();
      return detail && detail !== headline && detail !== error.code
        ? `${headline}\n${detail}`
        : headline;
    }
    if (error instanceof Error) return error.message;
    return String(error);
  }, [t]);
}
