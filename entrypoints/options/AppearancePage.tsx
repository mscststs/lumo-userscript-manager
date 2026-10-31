import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { AccentColor, FontSize, ThemeMode, UISettings } from '@/types';
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
import {
  ACCENT_OPTIONS,
  DARK_THEME_OPTIONS,
  THEME_MODE_OPTIONS,
  type ThemeDefinition,
} from '@/lib/theme-registry';
import { FONT_SIZE_OPTIONS } from '@/lib/font-size-registry';
import { LANGUAGES } from '@/lib/language';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { SettingRow } from '@/components/settings/SettingRow';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Switch } from '@/components/ui/switch';
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
 *
 * Mode and dark palette are both answered with the same miniature-window
 * cards, on the same grid, so the two questions read as one family of choices
 * and each card shows what it will do before it is picked.
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
      header={<PageHeader title={t('options.appearance.title')} />}
      contentClassName="space-y-7"
      width="form"
    >
      <Section title={t('options.appearance.mode')} hint={t('options.appearance.modeHint')}>
        <div
          role="radiogroup"
          aria-label={t('options.appearance.mode')}
          className={CARD_GRID}
        >
          {THEME_MODE_OPTIONS.map((option) => (
            <ChoiceCard
              key={option.value}
              active={mode === option.value}
              label={t(option.labelKey)}
              onClick={() => void setMode(option.value)}
            >
              <ModePreview mode={option.value} darkTheme={THEMES[darkTheme]} accent={accent} />
            </ChoiceCard>
          ))}
        </div>
      </Section>

      <Section
        title={t('options.appearance.darkTheme')}
        hint={t('options.appearance.darkThemeHint')}
      >
        <div
          role="radiogroup"
          aria-label={t('options.appearance.darkTheme')}
          className={CARD_GRID}
        >
          {DARK_THEME_OPTIONS.map((option) => (
            <ChoiceCard
              key={option.value}
              active={darkTheme === option.value}
              label={t(option.labelKey)}
              onClick={() => void setDarkTheme(option.value)}
            >
              <WindowPreview
                swatch={THEMES[option.value].swatch}
                accent={accentPreviewColor(accent, 'dark')}
              />
            </ChoiceCard>
          ))}
        </div>
        {resolved === 'light' && (
          <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
            {t('options.appearance.darkThemeInactive')}
          </p>
        )}
      </Section>

      <Section title={t('options.appearance.accent')} hint={t('options.appearance.accentHint')}>
        <div
          role="radiogroup"
          aria-label={t('options.appearance.accent')}
          className="flex flex-wrap items-center gap-1.5"
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
                  'inline-flex h-8 items-center gap-1.5 rounded-control border px-2 text-xs',
                  'transition-[color,background-color,border-color,box-shadow] duration-150 ease-standard',
                  // Selected is the same raised chip as the sidebar selection
                  // and the segmented thumb: one shape means "this one".
                  active
                    ? 'border-border/60 bg-card text-foreground shadow-elev1'
                    : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex h-4 w-4 items-center justify-center rounded-full"
                  style={{ backgroundColor: color }}
                >
                  {active && <Check className="h-2.5 w-2.5 text-primary-foreground" strokeWidth={3} />}
                </span>
                <span className="hidden sm:inline">{t(option.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <SettingsGroup title={t('options.appearance.groupInterface')}>
        <SettingRow
          label={t('options.appearance.showBadge')}
          htmlFor="appearance-badge"
          description={t('options.appearance.showBadgeHint')}
          control={
            <Switch
              id="appearance-badge"
              checked={settings?.showBadge !== false}
              onCheckedChange={(checked) => void update({ showBadge: checked })}
              aria-label={t('options.appearance.showBadge')}
            />
          }
        />
      </SettingsGroup>

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

/** Both card groups share one grid so every preview is the same size. */
const CARD_GRID = 'grid max-w-xl grid-cols-3 gap-2.5';

/** Heading + hint + body, typeset exactly like a `SettingsGroup` heading. */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {hint && (
        <p className="mt-0.5 max-w-[62ch] text-xs leading-relaxed text-muted-foreground text-pretty">
          {hint}
        </p>
      )}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/** A radio rendered as a preview card: miniature on top, label and mark below. */
function ChoiceCard({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-card border p-1.5 text-left',
        'transition-[border-color,background-color,box-shadow] duration-150 ease-standard',
        active
          ? 'border-primary/70 bg-card shadow-elev1'
          : 'border-border bg-card shadow-surface hover:border-muted-foreground/40',
      )}
    >
      <span className="relative block h-16 w-full overflow-hidden rounded-md">{children}</span>
      <span className="flex min-w-0 items-center justify-between gap-1 px-0.5">
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{label}</span>
        <span
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ease-standard',
            active ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
          )}
        >
          {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </span>
      </span>
    </button>
  );
}

/**
 * The options window in miniature, painted from a palette swatch: the frame,
 * a sidebar with its raised selection, and the content panel holding a title,
 * a line of text and an accent button. Colours come from the theme registry
 * (pinned to the CSS tokens by tests), never from literals.
 */
function WindowPreview({
  swatch,
  accent,
  style,
}: {
  swatch: ThemeDefinition['swatch'];
  accent: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className="absolute inset-0 block"
      style={{ background: swatch.frame, ...style }}
    >
      <span className="absolute left-1.5 top-2 flex w-[22%] flex-col gap-1">
        <span
          className="block h-2 w-full rounded-[2px] border"
          style={{ background: swatch.surface, borderColor: swatch.border }}
        />
        <span
          className="ml-0.5 block h-1 w-3/4 rounded-full"
          style={{ background: swatch.foreground, opacity: 0.22 }}
        />
        <span
          className="ml-0.5 block h-1 w-2/3 rounded-full"
          style={{ background: swatch.foreground, opacity: 0.22 }}
        />
      </span>
      <span
        className="absolute bottom-1.5 left-[30%] right-1.5 top-1.5 rounded-[4px] border"
        style={{ background: swatch.background, borderColor: swatch.border }}
      >
        <span
          className="absolute left-1.5 top-1.5 h-1 w-6 rounded-full"
          style={{ background: swatch.foreground, opacity: 0.75 }}
        />
        <span
          className="absolute left-1.5 top-3.5 h-1 w-9 max-w-[80%] rounded-full"
          style={{ background: swatch.border }}
        />
        <span
          className="absolute bottom-1.5 left-1.5 h-2.5 w-7 rounded-[2px]"
          style={{ background: accent }}
        />
      </span>
    </span>
  );
}

/**
 * Preview for a mode. "System" is both palettes split on the diagonal: it is
 * not a third look, it is whichever of the other two the OS asks for.
 */
function ModePreview({
  mode,
  darkTheme,
  accent,
}: {
  mode: ThemeMode;
  darkTheme: ThemeDefinition;
  accent: AccentColor;
}) {
  const light = (
    <WindowPreview swatch={THEMES.light.swatch} accent={accentPreviewColor(accent, 'light')} />
  );
  const dark = (style?: CSSProperties) => (
    <WindowPreview
      swatch={darkTheme.swatch}
      accent={accentPreviewColor(accent, 'dark')}
      style={style}
    />
  );
  if (mode === 'light') return light;
  if (mode === 'dark') return dark();
  return (
    <>
      {light}
      {dark({ clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' })}
    </>
  );
}
