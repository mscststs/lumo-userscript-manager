import type { UISettings } from '@/types';
import {
  STORAGE_FIELDS,
  EXPORTABLE_KEYS,
  type StorageSchema,
  type StorageKey,
} from './storage-schema';

// ---------------------------------------------------------------------------
// Generic helpers driven by the schema registry
// ---------------------------------------------------------------------------

/** Read a single key from chrome.storage.local, applying defaults + normalize. */
async function getField<K extends StorageKey>(key: K): Promise<StorageSchema[K]> {
  const field = STORAGE_FIELDS[key];
  const result = await chrome.storage.local.get(key);
  const raw = result[key] as StorageSchema[K] | undefined;
  if (raw === undefined) return field.defaultValue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return field.normalize ? (field.normalize as any)(raw) : raw;
}

/** Write a single key to chrome.storage.local. */
async function setField<K extends StorageKey>(
  key: K,
  value: StorageSchema[K],
): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

// ---------------------------------------------------------------------------
// Exported config type — automatically covers all exportable keys
// ---------------------------------------------------------------------------

/**
 * Portable configuration bundle for import/export.
 * At runtime, only keys with `exportable: true` in the registry are actually
 * written/read. The type is permissive so older config files with missing keys
 * import cleanly.
 */
export type AppConfig = Partial<StorageSchema>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let runtimeSecretPromise: Promise<string> | null = null;

export const storage = {
  // ----- UI Settings -----
  async getUISettings(): Promise<UISettings> {
    return getField('uiSettings');
  },
  async setUISettings(settings: UISettings): Promise<void> {
    await setField('uiSettings', settings);
  },

  // ----- Log view pointer -----
  async getLogsSeenAt(): Promise<number> {
    return getField('logsSeenAt');
  },
  async setLogsSeenAt(time: number): Promise<void> {
    await setField('logsSeenAt', time);
  },

  // ----- Export / Import (driven by registry) -----

  /**
   * Read (or lazily create) the per-install secret used to sign userscript
   * runtime tokens. It lives in local storage because it is a few bytes and
   * must be readable from a freshly started service worker.
   */
  async ensureRuntimeSecret(): Promise<string> {
    if (!runtimeSecretPromise) {
      runtimeSecretPromise = (async () => {
        const existing = await getField('runtimeSecret');
        if (existing.length >= 32) return existing;
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const secret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        await setField('runtimeSecret', secret);
        return secret;
      })().catch((error) => {
        runtimeSecretPromise = null;
        throw error;
      });
    }
    return runtimeSecretPromise;
  },

  /**
   * Export all settings marked `exportable: true` in the schema registry.
   * New settings added to the registry are automatically included.
   */
  async exportConfig(): Promise<AppConfig> {
    const keys = EXPORTABLE_KEYS;
    const result = await chrome.storage.local.get(keys);
    const config: AppConfig = {};

    for (const key of keys) {
      const field = STORAGE_FIELDS[key];
      const raw = result[key];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = raw === undefined ? field.defaultValue : (field.normalize ? (field.normalize as any)(raw) : raw);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any)[key] = value;
    }

    return config;
  },

  /**
   * Import settings from a config bundle.
   * Only keys present in the bundle AND marked `exportable` are written.
   * Normalize functions are applied automatically.
   */
  async importConfig(config: AppConfig): Promise<void> {
    const writes: Record<string, unknown> = {};

    for (const key of EXPORTABLE_KEYS) {
      const value = (config as Record<string, unknown>)[key];
      if (value === undefined) continue;

      const field = STORAGE_FIELDS[key];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      writes[key] = field.normalize ? (field.normalize as any)(value) : value;
    }

    // Batch write for atomicity.
    if (Object.keys(writes).length > 0) {
      await chrome.storage.local.set(writes);
    }
  },
};
