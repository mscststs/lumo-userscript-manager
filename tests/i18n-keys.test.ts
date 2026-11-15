import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_LOCALE, LOCALES } from '@/i18n/locales';
import {
  ACCENT_OPTIONS,
  DARK_THEME_OPTIONS,
  THEME_MODE_OPTIONS,
} from '@/lib/theme-registry';
import { FONT_SIZE_OPTIONS } from '@/lib/font-size-registry';

function flatten(source: object, prefix = ''): string[] {
  return Object.entries(source).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' ? flatten(value, path) : [path];
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

/** Static `t('…')` keys used by renderer code. Catches the class of bug where a
 *  label silently renders as "settings.export" because the key was never added. */
function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of [...sourceFiles('entrypoints'), ...sourceFiles('components')]) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bt\(\s*'([^'`$]+)'/g)) {
      const key = match[1]!;
      // Doc comments show example calls (`t('...apiKey')`); only namespaced
      // keys are real translation lookups.
      if (/^(common|app|popup|options|scripts|metadata|editor|settings|logs|install|errors|diagnostics)\./.test(key)) {
        keys.add(key);
      }
    }
  }
  return keys;
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function keySet(bundle: object): Set<string> {
  const keys = new Set<string>();
  for (const key of flatten(bundle)) keys.add(key.replace(PLURAL_SUFFIX, ''));
  return keys;
}

const localeDir = path.resolve(__dirname, '../i18n/locales');
const bundles = readdirSync(localeDir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => [file.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(localeDir, file), 'utf8'))] as const);
const en = bundles.find(([tag]) => tag === DEFAULT_LOCALE)![1];

describe('i18n resources', () => {
  it('ships a complete bundle for every registered locale', () => {
    expect(bundles).toHaveLength(LOCALES.length);
    const canonical = [...keySet(en)].sort();
    for (const [tag, bundle] of bundles) {
      expect([...keySet(bundle)].sort(), tag).toEqual(canonical);
    }
  });

  it('resolves every static t() key used by the UI', () => {
    const keys = keySet(en);
    for (const key of usedKeys()) {
      expect(keys.has(key), `missing translation for ${key}`).toBe(true);
    }
  });

  it('resolves every registry label key', () => {
    const keys = keySet(en);
    const registryKeys = [
      ...THEME_MODE_OPTIONS.map((option) => option.labelKey),
      ...DARK_THEME_OPTIONS.map((option) => option.labelKey),
      ...DARK_THEME_OPTIONS.map((option) => option.descriptionKey),
      ...ACCENT_OPTIONS.map((option) => option.labelKey),
      ...FONT_SIZE_OPTIONS.map((option) => option.labelKey),
    ];

    for (const key of registryKeys) {
      expect(keys.has(key), `missing translation for ${key}`).toBe(true);
    }
  });
});
