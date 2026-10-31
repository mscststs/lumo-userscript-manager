/**
 * Allowed font-size presets (in pixels). Applied to `<html>` to scale all
 * `rem`-based UI proportionally.
 */
export type FontSize = 12 | 13 | 14 | 15 | 16 | 17 | 18;

/**
 * A concrete palette. Each one maps 1:1 to a token block in `assets/globals.css`
 * and to an entry in `THEMES` (`lib/theme-registry.ts`).
 *
 * `light` is the only light palette; `dark` (Graphite) and `midnight` are the
 * dark palettes the user can choose between.
 */
export type ResolvedTheme = 'light' | 'dark' | 'midnight';

/** Palette used whenever the resolved scheme is dark. */
export type DarkTheme = 'dark' | 'midnight';

/**
 * Light/dark *preference*, deliberately separate from which dark palette is
 * used. `'system'` was previously a member of the palette union, which made it
 * impossible to answer "when the OS goes dark, which dark palette should I use?"
 * without a second field anyway.
 */
export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Accent hue preset.
 *
 * Orthogonal to {@link ThemeMode} / {@link ResolvedTheme}: the palette fixes
 * lightness and contrast, the
 * accent only rotates the hue of `primary` / `ring`. See `lib/theme-registry`.
 */
export type AccentColor = 'azure' | 'violet' | 'emerald' | 'amber' | 'rose';

/** Stored language preference. `auto` follows the browser UI language. */
export type Language = 'auto' | 'en' | 'zh';

export type DefaultRunAt = 'document-idle' | 'document-end' | 'document-start';
export type DefaultInjectInto = 'auto' | 'page' | 'content';
export type UserLogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * Trust configuration for the agent-facing MCP endpoint.
 *
 * The endpoint is deny-by-default: the user turns it on *and* lists the
 * extension IDs allowed to call it. Chrome extension IDs are the only stable
 * identity a receiver gets (`sender.id`), so they are the allowlist.
 */
export interface AgentSettings {
  enabled: boolean;
  allowedExtensionIds: string[];
  /** Allow the agent to create/edit/enable/disable/trash scripts. Defaults to on. */
  allowWrites: boolean;
  /** New agent-authored scripts stay disabled until the user reviews them. Defaults to off. */
  reviewWrites: boolean;
  /** Open this extension's settings when an unknown extension asks for access. */
  promptOnRequest: boolean;
}

/**
 * An extension that probed the agent endpoint but is not on the allowlist.
 *
 * Bounded and non-exportable: it is runtime consent state, not configuration.
 * `name`/`version` are self-reported by the caller and are only a display hint;
 * the extension ID is the authoritative identity.
 */
export interface AgentPendingRequest {
  id: string;
  name?: string;
  version?: string;
  firstSeen: number;
  lastSeen: number;
  promptedAt?: number;
  dismissedAt?: number;
}

/** Settings that affect every extension page and the runtime. */
export interface UISettings {
  language: Language;
  /** Light/dark preference. */
  theme: ThemeMode;
  /** Palette painted when the resolved scheme is dark. */
  darkTheme: DarkTheme;
  /** Hue of every accent-derived token. */
  accent: AccentColor;
  /** Global UI font size in pixels. */
  fontSize: FontSize;

  /** Master switch for script injection. */
  scriptsEnabled: boolean;
  /** Show the number of active scripts on the toolbar icon. */
  showBadge: boolean;
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
