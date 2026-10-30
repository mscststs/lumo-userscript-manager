import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCENT,
  DEFAULT_DARK_THEME,
  DEFAULT_THEME_MODE,
} from '@/lib/theme-registry';
import { DEFAULT_FONT_SIZE } from '@/lib/font-size-registry';
import { DEFAULT_LANGUAGE } from '@/lib/language';
import { EXPORTABLE_KEYS, STORAGE_FIELDS } from '@/store/storage-schema';
import type { UISettings } from '@/types';

const normalizeUI = STORAGE_FIELDS.uiSettings.normalize!;

describe('storage schema', () => {
  it('exports every key marked exportable', () => {
    expect(EXPORTABLE_KEYS).toContain('uiSettings');
    expect(EXPORTABLE_KEYS).toEqual(
      (Object.keys(STORAGE_FIELDS) as (keyof typeof STORAGE_FIELDS)[]).filter(
        (key) => STORAGE_FIELDS[key].exportable,
      ),
    );
  });

  it('ships defaults that are themselves valid', () => {
    const settings = normalizeUI(STORAGE_FIELDS.uiSettings.defaultValue);
    expect(settings).toEqual({
      language: DEFAULT_LANGUAGE,
      theme: DEFAULT_THEME_MODE,
      darkTheme: DEFAULT_DARK_THEME,
      accent: DEFAULT_ACCENT,
      fontSize: DEFAULT_FONT_SIZE,
      scriptsEnabled: true,
      defaultRunAt: 'document-idle',
      defaultInjectInto: 'auto',
      forceSandbox: false,
      autoUpdate: true,
      updateIntervalHours: 6,
      logLevel: 'info',
    });
  });

  it('repairs values written by an unknown build or hand-edited config', () => {
    const raw = {
      language: 'fr',
      theme: 'solarized',
      fontSize: 99,
    } as unknown as UISettings;

    const settings = normalizeUI(raw);
    expect(settings.language).toBe(DEFAULT_LANGUAGE);
    expect(settings.theme).toBe(DEFAULT_THEME_MODE);
    expect(settings.darkTheme).toBe(DEFAULT_DARK_THEME);
    expect(settings.accent).toBe(DEFAULT_ACCENT);
    expect(settings.fontSize).toBe(DEFAULT_FONT_SIZE);
  });

  it('migrates a legacy `theme: midnight` into dark + Midnight', () => {
    const settings = normalizeUI({
      ...STORAGE_FIELDS.uiSettings.defaultValue,
      theme: 'midnight',
    } as unknown as UISettings);
    expect(settings.theme).toBe('dark');
    expect(settings.darkTheme).toBe('midnight');
  });

  it('keeps valid persisted values across every preset', () => {
    for (const theme of ['light', 'dark', 'system'] as const) {
      expect(normalizeUI({ ...STORAGE_FIELDS.uiSettings.defaultValue, theme }).theme).toBe(theme);
    }
    for (const darkTheme of ['dark', 'midnight'] as const) {
      expect(
        normalizeUI({ ...STORAGE_FIELDS.uiSettings.defaultValue, darkTheme }).darkTheme,
      ).toBe(darkTheme);
    }
    for (const language of ['auto', 'en', 'zh'] as const) {
      expect(
        normalizeUI({ ...STORAGE_FIELDS.uiSettings.defaultValue, language }).language,
      ).toBe(language);
    }
    for (const fontSize of [12, 13, 14, 15, 16, 17, 18] as const) {
      expect(
        normalizeUI({ ...STORAGE_FIELDS.uiSettings.defaultValue, fontSize }).fontSize,
      ).toBe(fontSize);
    }
  });
});
