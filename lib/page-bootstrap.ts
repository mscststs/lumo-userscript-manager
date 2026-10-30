import { applyLanguage, watchLanguageChanges } from '@/i18n';
import { applyAccent, applyTheme } from '@/lib/theme';
import { applyFontSize } from '@/lib/font-size';
import { scheduleOpticalShift } from '@/lib/optical';
import { normalizeAccent, normalizeDarkTheme, normalizeThemeMode } from '@/lib/theme-registry';
import { normalizeFontSize } from '@/lib/font-size-registry';
import { storage } from '@/store/storage';

/**
 * Everything that must be settled before an extension page renders its first
 * frame — and deliberately nothing else.
 *
 * Two things qualify: the UI language (text rendered in the wrong language then
 * swapped is worse than a slightly later first frame) and the theme (a light
 * frame repainted dark is the flash this module exists to remove). Both live in
 * the single `uiSettings` record, so one read serves both. Reading them
 * separately made cold start the *sum* of two round trips and pushed the theme
 * until after React had already mounted and painted.
 *
 * Anything that is not required for a correct first frame belongs after render,
 * behind its own loading state.
 */
export async function bootstrapPage(): Promise<void> {
  try {
    const settings = await storage.getUISettings();
    await applyLanguage(settings.language);
    applyTheme(
      normalizeThemeMode(settings.theme),
      normalizeDarkTheme(settings.darkTheme, settings.theme),
    );
    applyAccent(normalizeAccent(settings.accent));
    applyFontSize(normalizeFontSize(settings.fontSize));
    // Glyph metrics depend on the resolved font stack, which the theme and
    // font-size above can change; measure after both have landed.
    scheduleOpticalShift();
  } catch (error) {
    // Render with defaults rather than not at all. `theme-preload.js` has
    // already painted the mirrored palette, so a failure here is usually
    // invisible; `ThemeInit` retries the read once mounted.
    console.error('[Lumo Us] Failed to bootstrap page settings:', error);
  }

  watchLanguageChanges();
}
