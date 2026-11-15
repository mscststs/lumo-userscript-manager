import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  SHIPPED_LOCALES,
  detectLanguage,
  findLocale,
  isShippedLocale,
  localeDirection,
  matchLocale,
  normalizeLanguage,
  resolveLanguage,
  sortLocalesForPicker,
} from '@/i18n/locales';

describe('locale registry', () => {
  it('keeps BCP-47 tags and Chrome codes unique and consistent', () => {
    const tags = new Set<string>();
    const chrome = new Set<string>();
    for (const locale of LOCALES) {
      expect(tags.has(locale.tag), `duplicate tag ${locale.tag}`).toBe(false);
      expect(chrome.has(locale.chrome), `duplicate chrome code ${locale.chrome}`).toBe(false);
      tags.add(locale.tag);
      chrome.add(locale.chrome);
      expect(locale.tag.replace(/-/g, '_')).toBe(locale.chrome);
      expect(locale.native.length).toBeGreaterThan(0);
      expect(locale.english.length).toBeGreaterThan(0);
    }
    expect(LOCALES.length).toBe(55);
    expect(SHIPPED_LOCALES.length).toBeGreaterThan(0);
    expect(SHIPPED_LOCALES.length).toBeLessThanOrEqual(LOCALES.length);
    expect(SHIPPED_LOCALES.every((locale) => locale.status === 'ready')).toBe(true);
  });

  it.each([
    ['en', 'en'],
    ['en-GB', 'en-GB'],
    ['en-AU', 'en-AU'],
    ['zh', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-Hans-CN', 'zh-CN'],
    ['zh-Hant', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['pt', 'pt-BR'],
    ['pt-PT', 'pt-PT'],
    ['es-MX', 'es-419'],
    ['es-ES', 'es'],
    ['iw', 'he'],
    ['in', 'id'],
    ['tl', 'fil'],
    ['nb', 'no'],
    ['nn', 'no'],
    ['sr-Latn', 'sr'],
    ['de-DE', 'de'],
    ['xx-YY', 'en'],
  ] as const)('matches %s to %s', (raw, expected) => {
    expect(matchLocale(raw)).toBe(expected);
  });

  it('normalises legacy and unknown values without loading an English UI under a foreign tag', () => {
    expect(normalizeLanguage('zh')).toBe('zh-CN');
    expect(normalizeLanguage('zh-TW')).toBe('zh-TW');
    expect(normalizeLanguage('xx-YY')).toBe('auto');
    expect(normalizeLanguage('xx-YY')).toBe('auto');
    expect(normalizeLanguage('auto')).toBe('auto');
    expect(normalizeLanguage(42)).toBe('auto');
  });

  it('resolves auto to a shipped tag', () => {
    expect(isShippedLocale(resolveLanguage('auto'))).toBe(true);
    expect(isShippedLocale(resolveLanguage('xx-YY'))).toBe(true);
  });

  it('knows text direction', () => {
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('he')).toBe('rtl');
    expect(localeDirection('fa')).toBe('rtl');
    expect(localeDirection('en')).toBe('ltr');
    expect(localeDirection('zh-CN')).toBe('ltr');
    expect(localeDirection('unknown')).toBe('ltr');
  });

  it('pins the active language and English in the picker', () => {
    const order = sortLocalesForPicker('zh-CN');
    expect(order[0]?.tag).toBe('zh-CN');
    expect(order[1]?.tag).toBe('en');
    expect(order.length).toBe(SHIPPED_LOCALES.length);
    expect(new Set(order.map((locale) => locale.tag)).size).toBe(order.length);
  });

  it('finds locales case-insensitively', () => {
    expect(findLocale('ZH-tw')?.tag).toBe('zh-TW');
    expect(findLocale('unknown')).toBeUndefined();
    expect(findLocale(undefined)).toBeUndefined();
  });

  it('has a shipped bundle for every ready descriptor', () => {
    for (const locale of SHIPPED_LOCALES) {
      expect(isShippedLocale(locale.tag)).toBe(true);
    }
    expect(detectLanguage()).toBeTruthy();
  });
});
