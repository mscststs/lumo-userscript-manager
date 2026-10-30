/**
 * Declarative Storage Schema Registry
 *
 * All `chrome.storage.local` keys are declared here with metadata. The
 * `exportable` flag controls whether a key is included in config import/export,
 * so adding a setting to the registry automatically covers export/import and
 * typed change-watching.
 *
 * Adding a new setting:
 * 1. Define its type in `StorageSchema`
 * 2. Add a `StorageFieldDef` entry in `STORAGE_FIELDS`
 * 3. Done — export/import/watch types all derive from this file.
 *
 * ## What belongs here
 *
 * `chrome.storage.local` is capped and serialises a whole key on every write,
 * so this area is reserved for values that are **bounded in size** and need
 * `onChanged` to reach other extension contexts — settings, selections and
 * pointers.
 *
 * Data that grows with use must not live here. Script source, version history
 * and logs belong in IndexedDB (or the file system), with only a bounded
 * revision counter in this area as the change-broadcast channel.
 */

import type { UISettings } from '@/types';
import { DEFAULT_THEME, normalizeTheme } from '@/lib/theme-registry';
import { DEFAULT_FONT_SIZE, normalizeFontSize } from '@/lib/font-size-registry';
import { DEFAULT_LANGUAGE, normalizeLanguage } from '@/lib/language';

// ---------------------------------------------------------------------------
// 1. Schema: all possible storage keys and their value types
// ---------------------------------------------------------------------------

/** The single source of truth for what lives in chrome.storage.local. */
export interface StorageSchema {
  uiSettings: UISettings;
  /**
   * Per-install HMAC secret for userscript runtime tokens.
   * Small, bounded and never exported; regenerating it invalidates tokens in
   * already-open pages, which then fail closed until they reload.
   */
  runtimeSecret: string;
}

/** Union of all valid storage key strings. */
export type StorageKey = keyof StorageSchema;

// ---------------------------------------------------------------------------
// 2. Field definition & registry
// ---------------------------------------------------------------------------

export interface StorageFieldDef<K extends StorageKey> {
  /** The chrome.storage.local key name. */
  key: K;
  /** Default value when nothing is stored. */
  defaultValue: StorageSchema[K];
  /** Whether this field should be included in config export/import. */
  exportable: boolean;
  /**
   * Optional migration/normalization function applied on read AND on import.
   * Use this for backwards-compat transforms and invalid-value repair.
   */
  normalize?: (raw: StorageSchema[K]) => StorageSchema[K];
}

export const DEFAULT_UI_SETTINGS: UISettings = {
  language: DEFAULT_LANGUAGE,
  theme: DEFAULT_THEME,
  fontSize: DEFAULT_FONT_SIZE,
  scriptsEnabled: true,
  defaultRunAt: 'document-idle',
  defaultInjectInto: 'auto',
  forceSandbox: false,
  autoUpdate: true,
  updateIntervalHours: 6,
  logLevel: 'info',
};

const RUN_AT_VALUES = new Set(['document-idle', 'document-end', 'document-start']);
const INJECT_VALUES = new Set(['auto', 'page', 'content']);
const LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);

function normalizeNumberInRange(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

/**
 * Central registry of all storage fields.
 *
 * To add a new setting:
 * 1. Add the key + type to `StorageSchema`
 * 2. Add a field entry below with `exportable: true`
 * 3. That's it — export/import picks it up automatically.
 */
export const STORAGE_FIELDS: { [K in StorageKey]: StorageFieldDef<K> } = {
  runtimeSecret: {
    key: 'runtimeSecret',
    defaultValue: '',
    exportable: false,
    normalize: (raw) => (typeof raw === 'string' ? raw : ''),
  },
  uiSettings: {
    key: 'uiSettings',
    defaultValue: DEFAULT_UI_SETTINGS,
    exportable: true,
    normalize: (raw) => ({
      ...DEFAULT_UI_SETTINGS,
      ...raw,
      language: normalizeLanguage(raw?.language),
      // Guards configs exported by a build that knows a theme this one does not
      // (and pre-field configs). An unrecognised value would otherwise reach
      // `data-theme`, match no token block, and silently leave light tokens.
      theme: normalizeTheme(raw?.theme),
      fontSize: normalizeFontSize(raw?.fontSize),
      scriptsEnabled: raw?.scriptsEnabled !== false,
      defaultRunAt:
        typeof raw?.defaultRunAt === 'string' && RUN_AT_VALUES.has(raw.defaultRunAt)
          ? raw.defaultRunAt
          : DEFAULT_UI_SETTINGS.defaultRunAt,
      defaultInjectInto:
        typeof raw?.defaultInjectInto === 'string' && INJECT_VALUES.has(raw.defaultInjectInto)
          ? raw.defaultInjectInto
          : DEFAULT_UI_SETTINGS.defaultInjectInto,
      forceSandbox: raw?.forceSandbox === true,
      autoUpdate: raw?.autoUpdate !== false,
      updateIntervalHours: normalizeNumberInRange(raw?.updateIntervalHours, 6, 1, 168),
      logLevel:
        typeof raw?.logLevel === 'string' && LOG_LEVELS.has(raw.logLevel)
          ? raw.logLevel
          : DEFAULT_UI_SETTINGS.logLevel,
    }),
  },
};

// ---------------------------------------------------------------------------
// 3. Helpers derived from registry
// ---------------------------------------------------------------------------

/** All keys that have `exportable: true`. */
export const EXPORTABLE_KEYS: StorageKey[] = (
  Object.keys(STORAGE_FIELDS) as StorageKey[]
).filter((key) => STORAGE_FIELDS[key].exportable);
