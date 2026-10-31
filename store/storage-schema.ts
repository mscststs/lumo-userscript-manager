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

import type { AgentPendingRequest, AgentSettings, UISettings } from '@/types';
import {
  DEFAULT_ACCENT,
  DEFAULT_DARK_THEME,
  DEFAULT_THEME_MODE,
  normalizeAccent,
  normalizeDarkTheme,
  normalizeThemeMode,
} from '@/lib/theme-registry';
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
  /**
   * Agent endpoint trust configuration: master switch + extension ID allowlist.
   * Deliberately not exportable — importing a backup must not grant another
   * machine's extensions access to this browser.
   */
  agentSettings: AgentSettings;
  /** Bounded queue of extensions waiting for the user's approval. */
  agentPendingRequests: AgentPendingRequest[];
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
  theme: DEFAULT_THEME_MODE,
  darkTheme: DEFAULT_DARK_THEME,
  accent: DEFAULT_ACCENT,
  fontSize: DEFAULT_FONT_SIZE,
  scriptsEnabled: true,
  showBadge: true,
  defaultRunAt: 'document-idle',
  defaultInjectInto: 'auto',
  forceSandbox: false,
  autoUpdate: true,
  updateIntervalHours: 6,
  logLevel: 'info',
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: false,
  allowedExtensionIds: [],
  allowWrites: true,
  reviewWrites: false,
  promptOnRequest: true,
};

const EXTENSION_ID_RE = /^[a-p]{32}$/;

/** Repair the bounded pending-request queue. */
export function normalizeAgentPendingRequests(raw: unknown): AgentPendingRequest[] {
  const now = Date.now();
  const seen = new Set<string>();
  const rows: AgentPendingRequest[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || !EXTENSION_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof record.name === 'string' ? record.name.trim().slice(0, 80) : '';
    const version = typeof record.version === 'string' ? record.version.slice(0, 32) : '';
    rows.push({
      id,
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      firstSeen: typeof record.firstSeen === 'number' ? record.firstSeen : now,
      lastSeen: typeof record.lastSeen === 'number' ? record.lastSeen : now,
      ...(typeof record.promptedAt === 'number' ? { promptedAt: record.promptedAt } : {}),
      ...(typeof record.dismissedAt === 'number' ? { dismissedAt: record.dismissedAt } : {}),
    });
  }
  return rows.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 5);
}

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
  agentSettings: {
    key: 'agentSettings',
    defaultValue: DEFAULT_AGENT_SETTINGS,
    exportable: false,
    normalize: (raw) => ({
      enabled: raw?.enabled === true,
      // Chrome extension IDs are 32 characters from a-p. Filtering here keeps a
      // hand-edited or imported value from becoming an allowlist entry that can
      // never match, and caps the list so the record stays bounded.
      allowedExtensionIds: Array.from(
        new Set(
          (Array.isArray(raw?.allowedExtensionIds) ? raw.allowedExtensionIds : []).filter(
            (id): id is string => typeof id === 'string' && /^[a-p]{32}$/.test(id),
          ),
        ),
      ).slice(0, 16),
      // Defaults are "writes on, review off"; an explicit stored value wins so
      // a user who turned either switch the other way keeps that choice.
      allowWrites: raw?.allowWrites !== false,
      reviewWrites: raw?.reviewWrites === true,
      promptOnRequest: raw?.promptOnRequest !== false,
    }),
  },
  agentPendingRequests: {
    key: 'agentPendingRequests',
    defaultValue: [],
    exportable: false,
    normalize: (raw) => normalizeAgentPendingRequests(raw),
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
      // `theme` used to carry the palette (`'midnight'`). A legacy record must
      // win over `darkTheme` even if that field exists with a default value,
      // otherwise a partially-written record would drop the user's palette.
      theme: normalizeThemeMode(raw?.theme),
      darkTheme:
        (raw?.theme as unknown) === 'midnight'
          ? 'midnight'
          : normalizeDarkTheme(raw?.darkTheme),
      accent: normalizeAccent(raw?.accent),
      fontSize: normalizeFontSize(raw?.fontSize),
      scriptsEnabled: raw?.scriptsEnabled !== false,
      // Opt-out added after the first release: an absent value means "on".
      showBadge: raw?.showBadge !== false,
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
