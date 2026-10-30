import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import type { RuntimeStatus, UISettings } from '@/types';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import { sendBg, onLumoEvent } from '@/lib/messages';
import { createBackupZip, readBackupZip } from '@/lib/backup';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DEFAULT_RUN_AT_VALUES, INJECT_INTO_OPTIONS, RUN_AT_OPTIONS } from '@/lib/script/metadata-options';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { SettingRow } from '@/components/settings/SettingRow';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EnumValue } from '@/components/ui/enum';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SectionNav } from '@/components/layout/SectionNav';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type SettingsSection = 'general' | 'updates' | 'data';

const RUN_AT = RUN_AT_OPTIONS.filter((option) => DEFAULT_RUN_AT_VALUES.includes(option.value));
const INJECT_INTO = INJECT_INTO_OPTIONS;
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

interface SettingsPageProps {
  section: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
}

/**
 * Settings page.
 *
 * Previously one long column where runtime, injection, updates, appearance and
 * data were separated only by uppercase labels — and where the Appearance block
 * rendered its own page header inside a section that already had one. Sections
 * are now real routes (`#/settings/:section`) so the segmented control is a
 * location, not a scroll position: reloading keeps you where you were.
 */
export function SettingsPage({ section, onNavigate }: SettingsPageProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [settings, setSettings] = useState<UISettings | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadRuntime = useCallback(async () => {
    try {
      setRuntime(await sendBg<RuntimeStatus>('runtime:status'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    storage
      .getUISettings()
      .then(setSettings)
      .catch((e: Error) => setError(e.message));
    void loadRuntime();
  }, [loadRuntime]);

  useEffect(
    () =>
      onLumoEvent((event) => {
        if (event === 'scripts-changed') void loadRuntime();
      }),
    [loadRuntime],
  );

  useStorageWatch<UISettings>('uiSettings', (next) => {
    if (next) setSettings(next);
  });

  const update = async (patch: Partial<UISettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setError(null);
    try {
      await storage.setUISettings(next);
      if (
        patch.scriptsEnabled !== undefined ||
        patch.defaultRunAt !== undefined ||
        patch.defaultInjectInto !== undefined ||
        patch.forceSandbox !== undefined
      ) {
        await sendBg('runtime:refresh');
        await loadRuntime();
      }
      if (patch.autoUpdate !== undefined || patch.updateIntervalHours !== undefined) {
        await sendBg('updates:setup');
      }
      toast({ title: t('settings.saved'), variant: 'success' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportBackup = async (format: 'json' | 'zip') => {
    try {
      const data = await sendBg<Record<string, unknown>>('backup:export');
      const date = new Date().toISOString().slice(0, 10);
      const blob =
        format === 'zip'
          ? new Blob([new Uint8Array(createBackupZip(data as never))], {
              type: 'application/zip',
            })
          : new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `lumo-userscripts-${date}.${format}`;
      anchor.click();
      URL.revokeObjectURL(href);
      toast({ title: t('scripts.exportDone'), variant: 'success' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const importBackup = async (file: File | undefined) => {
    if (!file) return;
    try {
      const data = file.name.toLowerCase().endsWith('.zip')
        ? readBackupZip(await file.arrayBuffer())
        : JSON.parse(await file.text());
      const result = await sendBg<{ imported: number; errors: string[] }>('backup:import', {
        data,
      });
      toast({
        title: t('settings.importSuccess', { count: result.imported }),
        description: result.errors.length ? result.errors.join('\n') : undefined,
        variant: result.errors.length ? 'error' : 'success',
      });
      await loadRuntime();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Sections are document tabs, not page actions: they sit under the title and
  // are shaped like tabs, so the action slot stays reserved for actions.
  const header = (
    <div className="space-y-3">
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      <SectionNav
        ariaLabel={t('settings.title')}
        value={section}
        onChange={onNavigate}
        className="-mb-3.5"
        items={[
          { value: 'general', label: t('settings.sections.general') },
          { value: 'updates', label: t('settings.sections.updates') },
          { value: 'data', label: t('settings.sections.data') },
        ]}
      />
    </div>
  );

  if (!settings) {
    return (
      <PageLayout header={header} width="form">
        <div className="space-y-3">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="rounded-card border border-border bg-card px-4 py-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-3 w-2/3" />
            </div>
          ))}
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout header={header} contentClassName="space-y-7" width="form">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-card border border-destructive/30 bg-destructive/5 px-3 py-2"
        >
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive">
            {error}
          </p>
          <Button variant="ghost" size="xs" onClick={() => setError(null)}>
            {t('common.close')}
          </Button>
        </div>
      )}

      {section === 'general' && (
        <>
          <SettingsGroup title={t('settings.groups.execution')}>
            <SettingRow
              label={t('settings.scriptsEnabled')}
              description={t('settings.scriptsEnabledHint')}
              control={
                <Switch
                  checked={settings.scriptsEnabled}
                  onCheckedChange={(checked) => void update({ scriptsEnabled: checked })}
                  aria-label={t('settings.scriptsEnabled')}
                />
              }
            />
            <SettingRow
              label={t('settings.defaultRunAt')}
              description={t('settings.defaultRunAtHint')}
              control={
                <Select
                  value={settings.defaultRunAt}
                  onValueChange={(value) =>
                    void update({ defaultRunAt: value as UISettings['defaultRunAt'] })
                  }
                >
                  <SelectTrigger className="w-64" aria-label={t('settings.defaultRunAt')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RUN_AT.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <EnumValue label={t(option.labelKey)} raw={option.value} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <SettingRow
              label={t('settings.defaultInjectInto')}
              description={t('settings.defaultInjectIntoHint')}
              control={
                <Select
                  value={settings.defaultInjectInto}
                  onValueChange={(value) =>
                    void update({ defaultInjectInto: value as UISettings['defaultInjectInto'] })
                  }
                >
                  <SelectTrigger className="w-64" aria-label={t('settings.defaultInjectInto')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INJECT_INTO.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <EnumValue label={t(option.labelKey)} raw={option.value} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <SettingRow
              label={t('settings.forceSandbox')}
              description={t('settings.forceSandboxHint')}
              control={
                <Switch
                  checked={settings.forceSandbox}
                  onCheckedChange={(checked) => void update({ forceSandbox: checked })}
                  aria-label={t('settings.forceSandbox')}
                />
              }
            />
          </SettingsGroup>

          <Card>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle>{t('settings.runtime')}</CardTitle>
                <CardDescription>{t('settings.runtimeHint')}</CardDescription>
              </div>
              <Badge variant={runtime?.userScriptsAvailable ? 'success' : 'destructive'}>
                <ShieldCheck className="h-3 w-3" />
                {runtime?.userScriptsAvailable
                  ? t('settings.runtimeAvailable')
                  : t('settings.runtimeUnavailable')}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label={t('settings.registered')} value={runtime?.registeredCount ?? 0} />
                <Stat label={t('settings.engines')} value={runtime?.engineCount ?? 0} />
                <Stat
                  label={t('settings.lastChecked')}
                  value={
                    runtime?.lastCheckedAt
                      ? formatDateTime(runtime.lastCheckedAt, i18n.language)
                      : '—'
                  }
                />
              </dl>
              {runtime?.lastError && (
                <p className="whitespace-pre-wrap break-words rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-2 text-2xs leading-relaxed text-destructive">
                  {runtime.lastError}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await sendBg('runtime:refresh');
                    await loadRuntime();
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('settings.reRegister')}
                </Button>
              </div>
            </CardContent>
          </Card>

          <SettingsGroup title={t('settings.groups.logging')}>
            <SettingRow
              label={t('settings.logLevel')}
              description={t('settings.logLevelHint')}
              control={
                <Select
                  value={settings.logLevel}
                  onValueChange={(value) =>
                    void update({ logLevel: value as UISettings['logLevel'] })
                  }
                >
                  <SelectTrigger className="w-64" aria-label={t('settings.logLevel')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOG_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        <EnumValue label={t(`settings.logLevels.${level}`)} raw={level} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
          </SettingsGroup>
        </>
      )}

      {section === 'updates' && (
        <SettingsGroup title={t('settings.groups.updates')}>
          <SettingRow
            label={t('settings.autoUpdate')}
            description={t('settings.autoUpdateHint')}
            control={
              <Switch
                checked={settings.autoUpdate}
                onCheckedChange={(checked) => void update({ autoUpdate: checked })}
                aria-label={t('settings.autoUpdate')}
              />
            }
          />
          <SettingRow
            label={t('settings.updateIntervalHours')}
            description={t('settings.updateIntervalHint')}
            control={
              <NumberField
                value={settings.updateIntervalHours}
                min={1}
                max={168}
                suffix={t('settings.hoursSuffix')}
                ariaLabel={t('settings.updateIntervalHours')}
                onCommit={(value) => void update({ updateIntervalHours: value })}
              />
            }
          />
        </SettingsGroup>
      )}

      {section === 'data' && (
        <>
          <SettingsGroup title={t('settings.groups.data')} description={t('settings.dataHint')}>
            <SettingRow
              label={t('settings.export')}
              description={t('settings.exportHint')}
              control={
                <div className="flex gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => void exportBackup('json')}>
                    <Download className="h-3.5 w-3.5" />
                    JSON
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void exportBackup('zip')}>
                    <Download className="h-3.5 w-3.5" />
                    ZIP
                  </Button>
                </div>
              }
            />
            <SettingRow
              label={t('settings.import')}
              description={t('settings.importHint')}
              control={
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                  <Upload className="h-3.5 w-3.5" />
                  {t('settings.import')}
                </Button>
              }
            />
          </SettingsGroup>

          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json,.zip"
            className="hidden"
            onChange={(event) => void importBackup(event.target.files?.[0])}
          />
        </>
      )}
    </PageLayout>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-sm font-medium tabular-nums text-foreground')}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Number input that commits on blur/Enter rather than on every keystroke.
 *
 * Writing each keypress to storage meant typing "24" produced a save for "2"
 * and one for "24" (and, with the old `|| 6` fallback, a save for "6" when the
 * field was momentarily empty). Intermediate states are local.
 */
function NumberField({
  value,
  min,
  max,
  onCommit,
  suffix,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  suffix?: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
        className="w-20 text-right tabular-nums"
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}
