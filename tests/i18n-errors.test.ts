import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { en } from '@/i18n/en';
import { ERROR_KEYS } from '@/lib/errors';
import { DIAGNOSTIC_KEYS } from '@/lib/diagnostics';

function valueAt(bundle: object, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    return node && typeof node === 'object'
      ? (node as Record<string, unknown>)[part]
      : undefined;
  }, bundle);
}

const localeDir = path.resolve(__dirname, '../i18n/locales');
const bundles = readdirSync(localeDir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => [file.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(localeDir, file), 'utf8'))] as const);

describe('localized error copy', () => {
  it('maps every error and diagnostic code to a real key in every locale', () => {
    for (const key of [...Object.values(ERROR_KEYS), ...Object.values(DIAGNOSTIC_KEYS)]) {
      for (const [name, bundle] of bundles) {
        const value = valueAt(bundle, key);
        expect(typeof value, `${name}: ${key}`).toBe('string');
        expect(String(value).trim(), `${name}: ${key} is empty`).not.toBe('');
      }
    }
  });

  it('has no duplicate translation key for a code', () => {
    const values = [...Object.values(ERROR_KEYS), ...Object.values(DIAGNOSTIC_KEYS)];
    expect(new Set(values).size).toBe(values.length);
  });

  it('keeps placeholders in diagnostic copy', () => {
    for (const [name, bundle] of bundles) {
      expect(valueAt(bundle, DIAGNOSTIC_KEYS['metadata.matchInvalid']), name).toContain('{{pattern}}');
    }
    expect(valueAt(en, DIAGNOSTIC_KEYS['metadata.matchInvalid'])).toContain('{{pattern}}');
  });
});
