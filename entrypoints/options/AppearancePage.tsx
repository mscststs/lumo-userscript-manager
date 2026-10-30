import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { AccentColor, DarkTheme, FontSize, UISettings } from '@/types';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import {
  accentPreviewColor,
  resolveTheme,
  useTheme,
  THEMES,
} from '@/lib/theme';
import { applyFontSize } from '@/lib/font-size';
import { applyLanguage } from '@/i18n';
import { ACCENT_OPTIONS, DARK_THEME_OPTIONS, THEME_MODE_OPTIONS } from '@/lib/theme-registry';
import { FONT_SIZE_OPTIONS } from '@/lib/font-size-registry';
import { LANGUAGES } from '@/lib/language';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { SettingRow } from '@/components/settings/SettingRow';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Segmented } from '@/components/ui/segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Appearance page (top-level).
 *
 * Three independent questions, in the order the user thinks about them:
 *   1. light, dark, or follow the system?      → `theme` (mode)
 *   2. if dark: Graphite or Midnight?          → `darkTheme`
 *   3. which accent hue?                        → `accent`
 *
 * They are separate fields because "follow the system" used to make question 2
 * unanswerable — the old model put the dark palette and the light/dark
 * preference in one union, so choosing `system` silently fixed the dark palette
 * to Graphite.
 *
 * There is no specimen card here: this page *is* the specimen. Every control
 * paints immediately, so a second mock card only repeats what is already on
 * screen while adding a scroll.
 */
export function AppearancePage() {
  const { t } = useTranslation();
  const { mode, darkTheme, accent, setMode, setDarkTheme, setAccent } = useTheme();
  const [settings, setSettings] = useState<UISettings | null>(null);

  useEffect(() => {
    storage.getUISettings().then(setSettings);
  }, []);

  useStorageWatch<UISettings>(
    'uiSettings',
    useCallback((next) => {
      if (next) setSettings(next);
    }, []),
  );

  const update = useCallback(async (patch: Partial<UISettings>) => {
    const current = await storage.getUISettings();
    const next = { ...current, ...patch };
    setSettings(next);
    if (patch.fontSize) applyFontSize(patch.fontSize);
    if (patch.language) void applyLanguage(patch.language);
    await storage.setUISettings(next);
  }, []);

  const resolved = resolveTheme(mode, darkTheme);
  const resolvedScheme = THEMES[resolved].scheme;
  const fontSize = settings?.fontSize ?? 16;
  const language = settings?.language ?? 'auto';

  return (
    <PageLayout
      header={
        <PageHeader
          title={t('options.appearance.title')}
          description={t('options.appearance.description')}
        />
      }
      contentClassName="max-w-3xl space-y-7"
    >
      <section>
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('options.appearance.mode')}
        </h2>
        <p className="mt-1 max-w-[62ch] text-xs leading-relaxed text-muted-foreground text-pretty">
          {t('options.appearance.modeHint')}
        </p>
        <Segmented
          className="mt-2.5"
          ariaLabel={t('options.appearance.mode')}
          value={mode}
          onChange={(value) => void setMode(value)}
          options={THEME_MODE_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
        />
      </section>

      <section>
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('options.appearance.darkTheme')}
        </h2>
        <p className="mt-1 max-w-[62ch] text-xs leading-relaxed text-muted-foreground text-pretty">
          {t('options.appearance.darkThemeHint')}
        </p>
        <div
          role="radiogroup"
          aria-label={t('options.appearance.darkTheme')}
          className="mt-2.5 grid max-w-xl grid-cols-2 gap-2"
        >
          {DARK_THEME_OPTIONS.map((option) => (
            <ThemeCard
              key={option.value}
              definition={THEMES[option.value]}
              active={darkTheme === option.value}
              accent={accent}
              scheme="dark"
              label={t(option.labelKey)}
              onClick={() => void setDarkTheme(option.value)}
            />
          ))}
        </div>
        {resolved === 'light' && (
          <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
            {t('options.appearance.darkThemeInactive')}
          </p>
        )}
      </section>

      <section>
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('options.appearance.accent')}
        </h2>
        <p className="mt-1 max-w-[62ch] text-xs leading-relaxed text-muted-foreground text-pretty">
          {t('options.appearance.accentHint')}
        </p>
        <div
          role="radiogroup"
          aria-label={t('options.appearance.accent')}
          className="mt-2.5 flex flex-wrap items-center gap-1.5"
        >
          {ACCENT_OPTIONS.map((option) => {
            const active = accent === option.value;
            const color = accentPreviewColor(option.value, resolvedScheme);
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={t(option.labelKey)}
                title={t(option.labelKey)}
                onClick={() => void setAccent(option.value)}
                className={cn(
                  'group inline-flex h-8 items-center gap-1.5 rounded-control border px-2 text-xs transition-colors duration-150',
                  active
                    ? 'border-border bg-accent text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-border hover:bg-accent/60',
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex h-4 w-4 items-center justify-center rounded-full"
                  style={{ backgroundColor: color }}
                >
                  {active && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                </span>
                <span className="hidden sm:inline">{t(option.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </section>

      <SettingsGroup title={t('options.appearance.groupTypography')}>
        <SettingRow
          label={t('options.appearance.language')}
          htmlFor="appearance-language"
          description={t('options.appearance.languageHint')}
          control={
            <Select
              value={language}
              onValueChange={(value) => void update({ language: value as UISettings['language'] })}
            >
              <SelectTrigger
                id="appearance-language"
                className="w-40"
                aria-label={t('options.appearance.language')}
              >
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
          description={t('options.appearance.fontSizeHint')}
          control={
            <Select
              value={String(fontSize)}
              onValueChange={(value) => void update({ fontSize: Number(value) as FontSize })}
            >
              <SelectTrigger
                id="appearance-font-size"
                className="w-40"
                aria-label={t('options.appearance.fontSize')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {t(option.labelKey)} · {option.value}px
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroup>
    </PageLayout>
  );
}

function ThemeCard({
  definition,
  active,
  accent,
  scheme,
  label,
  onClick,
}: {
  definition: (typeof THEMES)[DarkTheme];
  active: boolean;
  accent: AccentColor;
  scheme: 'light' | 'dark';
  label: string;
  onClick: () => void;
}) {
  const { swatch } = definition;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'group flex min-w-0 flex-col gap-1.5 rounded-card border p-1.5 text-left transition-[border-color,background-color,box-shadow] duration-150',
        active
          ? 'border-primary/60 bg-accent/40 shadow-elev1'
          : 'border-border bg-card hover:border-muted-foreground/40',
      )}
    >
      <span
        aria-hidden="true"
        className="relative block h-16 w-full overflow-hidden rounded-md border"
        style={{ background: swatch.background, borderColor: swatch.border }}
      >
        <span
          className="absolute inset-x-1.5 bottom-1.5 top-1.5 rounded-[4px] border"
          style={{ background: swatch.surface, borderColor: swatch.border }}
        >
          <span
            className="absolute left-1.5 top-1.5 h-1 w-6 rounded-full"
            style={{ background: swatch.foreground, opacity: 0.75 }}
          />
          <span
            className="absolute left-1.5 top-3.5 h-1 w-9 rounded-full"
            style={{ background: swatch.border }}
          />
          <span
            className="absolute bottom-1.5 left-1.5 h-2.5 w-7 rounded-[2px]"
            style={{ background: accentPreviewColor(accent, scheme) }}
          />
        </span>
      </span>
      <span className="flex min-w-0 items-center justify-between gap-1 px-0.5">
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{label}</span>
        <span
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
            active ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
          )}
        >
          {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </span>
      </span>
    </button>
  );
}
