/**
 * Theme registry — the single source of truth for which palettes exist.
 *
 * Deliberately free of React and storage imports: `store/storage-schema` needs
 * the normalizers to sanitise persisted values, while `lib/theme` (the React
 * layer) imports storage. Keeping the registry here breaks that cycle.
 *
 * ## Three axes, three questions
 *
 * - **mode** (`ThemeMode`): do you want light, dark, or whatever the OS does?
 * - **dark palette** (`DarkTheme`): when the answer is dark, Graphite or Midnight?
 * - **accent** (`AccentColor`): which hue for primary/ring?
 *
 * They used to be one `theme` string with `'system'` inside the palette union,
 * which made "follow the system, but use Midnight when it is dark" impossible
 * to express. Splitting the preference from the palettes is what lets the
 * appearance page offer the dark-palette choice independently.
 *
 * ## Why `background` lives here
 *
 * `theme-preload.js` has to paint the exact canvas colour before any stylesheet
 * exists. It cannot import this module (it is a classic script copied verbatim
 * into the build), so `applyTheme` mirrors `{ name, dark, background }` into
 * `localStorage` and the preload script trusts that JSON. This registry is the
 * only producer of those values; the preload only needs defaults for the very
 * first launch. Both are asserted against `--color-background` in
 * `tests/theme.test.ts`, so a retint cannot silently reintroduce a white flash.
 */

import type { AccentColor, DarkTheme, ResolvedTheme, ThemeMode } from '@/types';

export type ThemeScheme = 'light' | 'dark';

export interface ThemeDefinition {
  /** Drives the `.dark` class, `color-scheme`, and the Shiki dark overrides. */
  scheme: ThemeScheme;
  labelKey: string;
  descriptionKey: string;
  /**
   * The first-paint canvas colour. Must be byte-identical to the palette's
   * `--color-background` in `assets/globals.css`. OKLCH is used verbatim so
   * there is no lossy hex round-trip between the two files.
   */
  background: string;
  /** Colours handed to the theme picker preview. All resolve from the palette. */
  swatch: {
    background: string;
    surface: string;
    border: string;
    foreground: string;
  };
}

/**
 * `labelKey` lives here rather than in the settings UI so a palette can never
 * ship with a hard-coded English label: the record is keyed by `ResolvedTheme`,
 * so TypeScript rejects a union extension until a label is supplied.
 */
export const THEMES: Record<ResolvedTheme, ThemeDefinition> = {
  light: {
    scheme: 'light',
    labelKey: 'options.appearance.themeLight',
    descriptionKey: 'options.appearance.themeLightDesc',
    background: 'oklch(0.985 0.002 95)',
    swatch: {
      background: 'oklch(0.985 0.002 95)',
      surface: 'oklch(1 0 0)',
      border: 'oklch(0.902 0.004 95)',
      foreground: 'oklch(0.205 0.008 285)',
    },
  },
  dark: {
    scheme: 'dark',
    labelKey: 'options.appearance.themeDark',
    descriptionKey: 'options.appearance.themeDarkDesc',
    background: 'oklch(0.168 0.004 270)',
    swatch: {
      background: 'oklch(0.168 0.004 270)',
      surface: 'oklch(0.205 0.004 270)',
      border: 'oklch(0.306 0.006 270)',
      foreground: 'oklch(0.962 0.002 270)',
    },
  },
  midnight: {
    scheme: 'dark',
    labelKey: 'options.appearance.themeMidnight',
    descriptionKey: 'options.appearance.themeMidnightDesc',
    background: 'oklch(0.196 0.026 262)',
    swatch: {
      background: 'oklch(0.196 0.026 262)',
      surface: 'oklch(0.232 0.028 262)',
      border: 'oklch(0.336 0.03 262)',
      foreground: 'oklch(0.958 0.008 262)',
    },
  },
};

/** Accent presets. `hue`/`chroma`/`lightness` mirror the `[data-accent]` blocks. */
export const ACCENTS: Record<
  AccentColor,
  { labelKey: string; hue: number; chroma: number; lightness: number }
> = {
  azure: { labelKey: 'options.appearance.accentAzure', hue: 258, chroma: 0.17, lightness: 0.552 },
  violet: {
    labelKey: 'options.appearance.accentViolet',
    hue: 296,
    chroma: 0.175,
    lightness: 0.552,
  },
  // Emerald sits slightly darker: at the shared lightness white-on-green only
  // reaches 4.42:1. Per-hue lightness keeps every preset above AA.
  emerald: {
    labelKey: 'options.appearance.accentEmerald',
    hue: 162,
    chroma: 0.135,
    lightness: 0.535,
  },
  amber: { labelKey: 'options.appearance.accentAmber', hue: 70, chroma: 0.135, lightness: 0.552 },
  rose: { labelKey: 'options.appearance.accentRose', hue: 18, chroma: 0.175, lightness: 0.552 },
};

export const THEME_PALETTES = Object.keys(THEMES) as ResolvedTheme[];

/** Palettes that can be selected for dark mode. */
export const DARK_THEME_OPTIONS: {
  value: DarkTheme;
  labelKey: string;
  descriptionKey: string;
}[] = (['dark', 'midnight'] as DarkTheme[]).map((value) => ({
  value,
  labelKey: THEMES[value].labelKey,
  descriptionKey: THEMES[value].descriptionKey,
}));

/** Light/dark preference, in display order (`system` last). */
export const THEME_MODE_OPTIONS: {
  value: ThemeMode;
  labelKey: string;
}[] = [
  { value: 'light', labelKey: 'options.appearance.modeLight' },
  { value: 'dark', labelKey: 'options.appearance.modeDark' },
  { value: 'system', labelKey: 'options.appearance.modeSystem' },
];

export const ACCENT_OPTIONS = (Object.keys(ACCENTS) as AccentColor[]).map((value) => ({
  value,
  labelKey: ACCENTS[value].labelKey,
  hue: ACCENTS[value].hue,
  chroma: ACCENTS[value].chroma,
  lightness: ACCENTS[value].lightness,
}));

/** Preference used when nothing valid is stored. */
export const DEFAULT_THEME_MODE: ThemeMode = 'system';

/** Dark palette used when nothing valid is stored. */
export const DEFAULT_DARK_THEME: DarkTheme = 'dark';

/** Dark palette assumed on the very first launch (mirrored by preload tests). */
export const SYSTEM_DARK_THEME: DarkTheme = 'dark';

/** Accent used when nothing valid is stored. */
export const DEFAULT_ACCENT: AccentColor = 'azure';

/**
 * Coerce an arbitrary persisted value into a known preference.
 *
 * `'midnight'` is the one legacy case that matters: before the split it was a
 * member of the single `theme` union, meaning "dark, in Midnight". Mapping it to
 * `dark` plus a `darkTheme` of `midnight` (see `normalizeDarkTheme`) keeps an
 * upgrading user's choice instead of silently reverting them to Graphite.
 */
export function normalizeThemeMode(value: unknown): ThemeMode {
  if (value === 'light' || value === 'dark' || value === 'system') return value;
  if (value === 'midnight') return 'dark';
  return DEFAULT_THEME_MODE;
}

export function normalizeDarkTheme(value: unknown, legacyTheme?: unknown): DarkTheme {
  if (value === 'dark' || value === 'midnight') return value;
  if (legacyTheme === 'midnight') return 'midnight';
  return DEFAULT_DARK_THEME;
}

export function normalizeAccent(value: unknown): AccentColor {
  if (typeof value === 'string' && value in ACCENTS) return value as AccentColor;
  return DEFAULT_ACCENT;
}

/** Kept as the palette-level guard used by tests and defensive reads. */
export function normalizeTheme(value: unknown): ResolvedTheme {
  if (typeof value === 'string' && value in THEMES) return value as ResolvedTheme;
  return 'light';
}
