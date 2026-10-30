import { useCallback, useEffect, useState } from 'react';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import type { AccentColor, DarkTheme, ResolvedTheme, ThemeMode, UISettings } from '@/types';
import {
  ACCENTS,
  DEFAULT_ACCENT,
  DEFAULT_DARK_THEME,
  DEFAULT_THEME_MODE,
  SYSTEM_DARK_THEME,
  THEMES,
  normalizeAccent,
  normalizeDarkTheme,
  normalizeThemeMode,
} from './theme-registry';

export {
  ACCENTS,
  ACCENT_OPTIONS,
  DARK_THEME_OPTIONS,
  DEFAULT_ACCENT,
  DEFAULT_DARK_THEME,
  DEFAULT_THEME_MODE,
  SYSTEM_DARK_THEME,
  THEMES,
  THEME_MODE_OPTIONS,
  THEME_PALETTES,
  normalizeAccent,
  normalizeDarkTheme,
  normalizeThemeMode,
} from './theme-registry';

/**
 * `localStorage` key holding the last painted appearance, read by
 * `public/theme-preload.js` before first paint.
 *
 * A cache, never the source of truth — that stays `chrome.storage.local`. It
 * exists solely because `chrome.storage` is async and so cannot be consulted
 * before the browser paints; `localStorage` is synchronous and shared across
 * every page on the extension origin.
 *
 * Value is JSON: `{ name, dark, background }`. Shipping the resolved
 * *background* (not just the palette name) is what lets the preload script stay
 * theme-agnostic — it never has to embed a palette table that can drift from
 * `assets/globals.css`. Only ever holds a concrete palette (never a preference),
 * so the preload does not have to re-run media queries for a value that was
 * already resolved here.
 */
const MIRROR_KEY = 'lumo-us:resolved-theme';

/** `localStorage` mirror of the accent, so the first paint is already tinted. */
const ACCENT_MIRROR_KEY = 'lumo-us:accent';

interface ThemeMirror {
  name: ResolvedTheme;
  dark: boolean;
  background: string;
}

/** Resolve the preference + dark palette into the palette to paint. */
export function resolveTheme(mode: ThemeMode, darkTheme: DarkTheme): ResolvedTheme {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return darkTheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? darkTheme : 'light';
}

/**
 * Paint a palette onto `<html>` via two coordinated channels:
 * - `.dark` class — drives Tailwind's `dark:` variant and the Shiki overrides,
 *   shared by every dark palette.
 * - `data-theme` attribute — selects the specific token block. Dark palettes
 *   layer on top of `.dark` as `.dark[data-theme='…']`, so each one only
 *   restates the tokens it changes.
 *
 * Also refreshes the `localStorage` mirror the preload script reads, so the
 * *next* page load in this palette starts out already correct.
 */
export function applyTheme(mode: ThemeMode, darkTheme: DarkTheme) {
  const root = document.documentElement;
  const resolved = resolveTheme(mode, darkTheme);
  const definition = THEMES[resolved];
  const dark = definition.scheme === 'dark';

  root.classList.toggle('dark', dark);
  root.dataset.theme = resolved;

  // Hand the first-paint inline styles back to the stylesheet.
  //
  // `theme-preload.js` writes an inline background and `color-scheme` because in
  // dev builds no stylesheet exists yet at first paint. Inline styles beat any
  // rule, so leaving them would freeze the page on the palette that was mirrored
  // and make every later theme switch a no-op for the canvas. By the time this
  // runs the stylesheet is live and owns both properties, so clearing them is
  // safe — and doing it here (rather than on a timer) means there is no frame in
  // which neither the inline style nor the stylesheet applies.
  if (root.hasAttribute('data-theme-preload')) {
    root.removeAttribute('data-theme-preload');
    root.style.backgroundColor = '';
    root.style.colorScheme = '';
  }

  // Swallowed deliberately: a failed mirror write (quota, disabled storage,
  // partitioned context) costs a flash on the next load and nothing more, so it
  // must not take down the paint that just succeeded.
  try {
    const mirror: ThemeMirror = {
      name: resolved,
      dark,
      background: definition.background,
    };
    localStorage.setItem(MIRROR_KEY, JSON.stringify(mirror));
  } catch {
    // no-op
  }
}

/**
 * Rotate the accent hue axis. The CSS resolves every accent-derived token from
 * `--accent-h` / `--accent-c`, so this is a single attribute write — no palette
 * repaint, no flash, and it composes with any base theme.
 */
export function applyAccent(accent: AccentColor) {
  const next = normalizeAccent(accent);
  document.documentElement.dataset.accent = next;
  try {
    localStorage.setItem(ACCENT_MIRROR_KEY, next);
  } catch {
    // no-op — same reasoning as the theme mirror
  }
}

/** Paint every appearance axis at once (bootstrap, and the appearance page). */
export function applyAppearance(
  mode: ThemeMode,
  darkTheme: DarkTheme,
  accent: AccentColor,
) {
  applyTheme(mode, darkTheme);
  applyAccent(accent);
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_THEME_MODE);
  const [darkTheme, setDarkThemeState] = useState<DarkTheme>(DEFAULT_DARK_THEME);
  const [accent, setAccentState] = useState<AccentColor>(DEFAULT_ACCENT);

  const sync = useCallback((settings: UISettings) => {
    const nextMode = normalizeThemeMode(settings.theme);
    const nextDark = normalizeDarkTheme(settings.darkTheme, settings.theme);
    const nextAccent = normalizeAccent(settings.accent);
    setModeState(nextMode);
    setDarkThemeState(nextDark);
    setAccentState(nextAccent);
    applyAppearance(nextMode, nextDark, nextAccent);
  }, []);

  useEffect(() => {
    storage.getUISettings().then(sync);
  }, [sync]);

  // Watch for changes from other contexts (e.g. the options page while the
  // popup is open).
  useStorageWatch<UISettings>(
    'uiSettings',
    useCallback(
      (newValue) => {
        if (newValue) sync(newValue);
      },
      [sync],
    ),
  );

  const persist = useCallback(async (patch: Partial<UISettings>) => {
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, ...patch });
  }, []);

  const setMode = useCallback(
    async (next: ThemeMode) => {
      const normalized = normalizeThemeMode(next);
      setModeState(normalized);
      applyTheme(normalized, darkTheme);
      await persist({ theme: normalized });
    },
    [darkTheme, persist],
  );

  const setDarkTheme = useCallback(
    async (next: DarkTheme) => {
      const normalized = normalizeDarkTheme(next);
      setDarkThemeState(normalized);
      applyTheme(mode, normalized);
      await persist({ darkTheme: normalized });
    },
    [mode, persist],
  );

  const setAccent = useCallback(
    async (next: AccentColor) => {
      const normalized = normalizeAccent(next);
      setAccentState(normalized);
      applyAccent(normalized);
      await persist({ accent: normalized });
    },
    [persist],
  );

  return { mode, darkTheme, accent, setMode, setDarkTheme, setAccent };
}

/**
 * Keeps the painted appearance correct for the lifetime of the page.
 *
 * Does *not* perform the initial paint: `theme-preload.js` paints the mirrored
 * palette before the first frame and `bootstrapPage` paints the authoritative
 * one before React mounts. This component only reacts to change — the OS
 * flipping appearance, or another context editing the setting — so mounting it
 * cannot cause a flash the way a read-on-mount effect would.
 */
export function ThemeInit() {
  useEffect(() => {
    let cancelled = false;

    const paint = () => {
      storage
        .getUISettings()
        .then((settings) => {
          if (cancelled) return;
          applyTheme(
            normalizeThemeMode(settings.theme),
            normalizeDarkTheme(settings.darkTheme, settings.theme),
          );
        })
        .catch((error) => {
          console.error('[Lumo Us] Failed to reconcile appearance:', error);
        });
    };

    paint();

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      storage.getUISettings().then((settings) => {
        if (normalizeThemeMode(settings.theme) === 'system') {
          applyTheme('system', normalizeDarkTheme(settings.darkTheme, settings.theme));
        }
      });
    };
    mediaQuery.addEventListener('change', handler);
    return () => {
      cancelled = true;
      mediaQuery.removeEventListener('change', handler);
    };
  }, []);

  useStorageWatch<UISettings>(
    'uiSettings',
    useCallback((newValue) => {
      if (!newValue) return;
      applyTheme(
        normalizeThemeMode(newValue.theme),
        normalizeDarkTheme(newValue.darkTheme, newValue.theme),
      );
      applyAccent(normalizeAccent(newValue.accent));
    }, []),
  );

  return null;
}

/** Accent hue/chroma lookup for previews that need to paint a swatch inline. */
export function accentPreviewColor(accent: AccentColor, scheme: 'light' | 'dark'): string {
  const { hue, chroma, lightness } = ACCENTS[accent];
  return scheme === 'dark'
    ? `oklch(0.78 ${(chroma * 0.78).toFixed(3)} ${hue})`
    : `oklch(${lightness} ${chroma} ${hue})`;
}
