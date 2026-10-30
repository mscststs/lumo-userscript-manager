import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, Upload } from 'lucide-react';
import type { RuntimeStatus, UISettings } from '@/types';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import { applyTheme } from '@/lib/theme';
import { applyFontSize } from '@/lib/font-size';
import { applyLanguage } from '@/i18n';
import { sendBg, onLumoEvent } from '@/lib/messages';
import { createBackupZip, readBackupZip } from '@/lib/backup';
import { formatDateTime } from '@/lib/format';
import { AppearancePage } from './Appearance';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { SettingRow } from '@/components/settings/SettingRow';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState<UISettings | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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

  // Appearance is edited by a child component that writes `uiSettings`
  // directly; keep the parent's copy in sync so a later General edit cannot
  // overwrite the theme/language/font choice with stale values.
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
      if (patch.theme) applyTheme(patch.theme);
      if (patch.fontSize) applyFontSize(patch.fontSize);
      if (patch.language) await applyLanguage(patch.language);
      if (
        patch.scriptsEnabled !== undefined ||
        patch.defaultRunAt !== undefined ||
        patch.defaultInjectInto !== undefined ||
        patch.forceSandbox !== undefined
      ) {
        await sendBg('runtime:refresh');
        await loadRuntime();
      }
      if (
        patch.autoUpdate !== undefined ||
        patch.updateIntervalHours !== undefined
      ) {
        await sendBg('updates:setup');
      }
      setMessage(t('settings.saved'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportBackup = async () => {
    try {
      const data = await sendBg<Record<string, unknown>>('backup:export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `lumo-userscripts-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(href);
      setMessage(t('scripts.exportDone'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportZip = async () => {
    try {
      const data = await sendBg<Record<string, any>>('backup:export');
      const bytes = createBackupZip(data);
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/zip' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `lumo-userscripts-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      URL.revokeObjectURL(href);
      setMessage(t('scripts.exportDone'));
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
      const result = await sendBg<{ imported: number; errors: string[] }>('backup:import', { data });
      setMessage(t('settings.importSuccess', { count: result.imported }));
      if (result.errors.length) setError(result.errors.join('\n'));
      await loadRuntime();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!settings) {
    return <p className="text-xs text-muted-foreground">{error ?? t('common.loading')}</p>;
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <SettingsHeader title={t('settings.title')} description={t('settings.description')} />
      {(message || error) && (
        <p className={`whitespace-pre-wrap text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}>
          {error ?? message}
        </p>
      )}

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('settings.general')}
        </h3>
        <div className="divide-y divide-border rounded-lg border border-border bg-card px-4">
          <SettingRow
            label={t('settings.scriptsEnabled')}
            control={
              <Switch
                checked={settings.scriptsEnabled}
                onCheckedChange={(checked) => void update({ scriptsEnabled: checked })}
              />
            }
          />
          <SettingRow
            label={t('settings.defaultRunAt')}
            control={
              <Select
                value={settings.defaultRunAt}
                onValueChange={(value) =>
                  void update({ defaultRunAt: value as UISettings['defaultRunAt'] })
                }
              >
                <SelectTrigger className="h-9 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="document-idle">document-idle</SelectItem>
                  <SelectItem value="document-end">document-end</SelectItem>
                  <SelectItem value="document-start">document-start</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <SettingRow
            label={t('settings.defaultInjectInto')}
            control={
              <Select
                value={settings.defaultInjectInto}
                onValueChange={(value) =>
                  void update({ defaultInjectInto: value as UISettings['defaultInjectInto'] })
                }
              >
                <SelectTrigger className="h-9 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  <SelectItem value="page">page</SelectItem>
                  <SelectItem value="content">content</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <SettingRow
            label={t('settings.forceSandbox')}
            control={
              <Switch
                checked={settings.forceSandbox}
                onCheckedChange={(checked) => void update({ forceSandbox: checked })}
              />
            }
          />
          <SettingRow
            label={t('settings.autoUpdate')}
            control={
              <Switch
                checked={settings.autoUpdate}
                onCheckedChange={(checked) => void update({ autoUpdate: checked })}
              />
            }
          />
          <SettingRow
            label={t('settings.updateIntervalHours')}
            control={
              <Input
                type="number"
                min={1}
                max={168}
                value={settings.updateIntervalHours}
                onChange={(event) =>
                  void update({ updateIntervalHours: Number(event.target.value) || 6 })
                }
                className="h-9 w-24"
              />
            }
          />
          <SettingRow
            label={t('settings.logLevel')}
            control={
              <Select
                value={settings.logLevel}
                onValueChange={(value) =>
                  void update({ logLevel: value as UISettings['logLevel'] })
                }
              >
                <SelectTrigger className="h-9 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['error', 'warn', 'info', 'debug'].map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </div>
        <p className="text-[11px] text-muted-foreground">{t('settings.scriptsEnabledHint')}</p>
        <p className="text-[11px] text-muted-foreground">{t('settings.forceSandboxHint')}</p>
        <p className="text-[11px] text-muted-foreground">{t('settings.autoUpdateHint')}</p>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('settings.runtime')}
        </h3>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Badge variant={runtime?.userScriptsAvailable ? 'accent' : 'destructive'}>
                {runtime?.userScriptsAvailable
                  ? t('settings.runtimeAvailable')
                  : t('settings.runtimeUnavailable')}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {t('settings.registered')}: {runtime?.registeredCount ?? 0} ·{' '}
                {t('settings.engines')}: {runtime?.engineCount ?? 0}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await sendBg('runtime:refresh');
                await loadRuntime();
              }}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.reRegister')}
            </Button>
          </div>
          {runtime?.lastError && (
            <p className="mt-2 whitespace-pre-wrap text-[11px] text-destructive">{runtime.lastError}</p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            {t('settings.lastChecked')}:{' '}
            {runtime?.lastCheckedAt ? formatDateTime(runtime.lastCheckedAt, i18n.language) : '—'}
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('settings.network')}
        </h3>
        <p className="text-[11px] text-muted-foreground">{t('settings.networkHint')}</p>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('settings.appearance')}
        </h3>
        <AppearancePage />
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('settings.data')}
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void exportBackup()}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {t('settings.export')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void exportZip()}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {t('settings.exportZip')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            {t('settings.import')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json,.zip"
            className="hidden"
            onChange={(event) => void importBackup(event.target.files?.[0])}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">{t('settings.dataHint')}</p>
      </section>
    </div>
  );
}
