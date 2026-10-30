import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FontSize, Theme, UISettings } from '@/types';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import { applyTheme } from '@/lib/theme';
import { applyFontSize } from '@/lib/font-size';
import { applyLanguage } from '@/i18n';
import { THEME_OPTIONS } from '@/lib/theme-registry';
import { FONT_SIZE_OPTIONS } from '@/lib/font-size-registry';
import { LANGUAGES } from '@/lib/language';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { SettingRow } from '@/components/settings/SettingRow';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Appearance settings.
 *
 * The three controls map 1:1 to the fields in `UISettings`, so this page is the
 * reference implementation for how a setting is persisted: read once, apply
 * optimistically, then write through the schema-driven storage layer. Other
 * contexts pick the change up over `chrome.storage.onChanged`.
 */
export function AppearancePage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<UISettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    storage
      .getUISettings()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch(() => {
        if (!cancelled) setError(t('errors.settingsLoadFailed'));
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  // Mirrors edits made in another context (side panel, a second options tab).
  useStorageWatch<UISettings>(
    'uiSettings',
    useCallback((newValue) => {
      if (newValue) setSettings(newValue);
    }, []),
  );

  const update = useCallback(
    async (patch: Partial<UISettings>) => {
      if (!settings) return;
      const next: UISettings = { ...settings, ...patch };
      setSettings(next);
      setError(null);

      // Paint immediately; the storage write below is the durable part.
      if (patch.theme) applyTheme(patch.theme);
      if (patch.fontSize) applyFontSize(patch.fontSize);
      if (patch.language) void applyLanguage(patch.language);

      try {
        await storage.setUISettings(next);
      } catch {
        setError(t('errors.settingsSaveFailed'));
      }
    },
    [settings, t],
  );

  if (!settings) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <SettingsHeader
          title={t('options.appearance.title')}
          description={t('options.appearance.description')}
        />
        <p className="text-xs text-muted-foreground">
          {error ?? t('common.loading')}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <SettingsHeader
        title={t('options.appearance.title')}
        description={t('options.appearance.description')}
        action={
          error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : undefined
        }
      />

      <div className="divide-y divide-border rounded-lg border border-border bg-card px-4">
        <SettingRow
          label={t('options.appearance.theme')}
          htmlFor="appearance-theme"
          control={
            <Select
              value={settings.theme}
              onValueChange={(value) => void update({ theme: value as Theme })}
            >
              <SelectTrigger id="appearance-theme" className="h-9 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <SettingRow
          label={t('options.appearance.language')}
          htmlFor="appearance-language"
          control={
            <Select
              value={settings.language}
              onValueChange={(value) =>
                void update({ language: value as UISettings['language'] })
              }
            >
              <SelectTrigger id="appearance-language" className="h-9 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <SettingRow
          label={t('options.appearance.fontSize')}
          htmlFor="appearance-font-size"
          control={
            <Select
              value={String(settings.fontSize)}
              onValueChange={(value) =>
                void update({ fontSize: Number(value) as FontSize })
              }
            >
              <SelectTrigger id="appearance-font-size" className="h-9 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </div>
    </div>
  );
}
