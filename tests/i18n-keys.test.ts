import { describe, expect, it } from 'vitest';
import { en } from '@/i18n/en';
import { zh } from '@/i18n/zh';
import {
  ACCENT_OPTIONS,
  DARK_THEME_OPTIONS,
  THEME_MODE_OPTIONS,
} from '@/lib/theme-registry';
import { FONT_SIZE_OPTIONS } from '@/lib/font-size-registry';
import { LANGUAGES } from '@/lib/language';

function flatten(source: object, prefix = ''): string[] {
  return Object.entries(source).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' ? flatten(value, path) : [path];
  });
}

describe('i18n resources', () => {
  it('ships the same key set in every language', () => {
    expect(flatten(zh).sort()).toEqual(flatten(en).sort());
  });

  it('resolves every registry label key', () => {
    const keys = new Set(flatten(en));
    const registryKeys = [
      ...THEME_MODE_OPTIONS.map((option) => option.labelKey),
      ...DARK_THEME_OPTIONS.map((option) => option.labelKey),
      ...DARK_THEME_OPTIONS.map((option) => option.descriptionKey),
      ...ACCENT_OPTIONS.map((option) => option.labelKey),
      ...FONT_SIZE_OPTIONS.map((option) => option.labelKey),
      ...LANGUAGES.map((option) => option.labelKey),
    ];

    for (const key of registryKeys) {
      expect(keys.has(key), `missing translation for ${key}`).toBe(true);
    }
  });
});
