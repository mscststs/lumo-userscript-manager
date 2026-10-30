/**
 * Allowed font-size presets (in pixels). Applied to `<html>` to scale all
 * `rem`-based UI proportionally.
 */
export type FontSize = 12 | 13 | 14 | 15 | 16 | 17 | 18;

/**
 * A user-selectable colour theme.
 *
 * `'system'` is a *preference*, not a palette — it resolves to one of the
 * concrete themes at apply time based on `prefers-color-scheme`. Every other
 * member maps 1:1 to a token block in `assets/globals.css`.
 *
 * Adding a theme is a two-step change: extend this union, then register it in
 * `THEMES` (see `lib/theme-registry.ts`) — TypeScript will flag every place
 * that needs updating, including the i18n label map.
 */
export type Theme = 'light' | 'dark' | 'midnight' | 'system';

/**
 * The subset of {@link Theme} that names an actual palette. `'system'` is
 * excluded because it always resolves to one of these before being applied.
 */
export type ResolvedTheme = Exclude<Theme, 'system'>;

/** Stored language preference. `auto` follows the browser UI language. */
export type Language = 'auto' | 'en' | 'zh';

export type DefaultRunAt = 'document-idle' | 'document-end' | 'document-start';
export type DefaultInjectInto = 'auto' | 'page' | 'content';
export type UserLogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Settings that affect every extension page and the runtime. */
export interface UISettings {
  language: Language;
  theme: Theme;
  /** Global UI font size in pixels. */
  fontSize: FontSize;

  /** Master switch for script injection. */
  scriptsEnabled: boolean;
  /** Used when a script does not declare @run-at. */
  defaultRunAt: DefaultRunAt;
  /** Used when a script does not declare @inject-into. */
  defaultInjectInto: DefaultInjectInto;
  /** Force every script with grants into USER_SCRIPT isolation. */
  forceSandbox: boolean;
  /** Automatically install updates that do not add permissions. */
  autoUpdate: boolean;
  updateIntervalHours: number;
  /** Minimum level persisted to the script log. */
  logLevel: UserLogLevel;
}

export * from './script';
