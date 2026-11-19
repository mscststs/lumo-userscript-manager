import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useErrorText } from '@/lib/use-error-text';
import { appErrorFromResponse } from '@/lib/errors';
import type { TranslationKey } from '@/i18n/keys';
import {
  FileArchive,
  FileJson,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import type { AgentAuditEntry } from '@/lib/db';
import type {
  AgentSettings,
  RuntimeStatus,
  UISettings,
  UserScriptsAvailabilityCode,
} from '@/types';
import { storage } from '@/store/storage';
import { useStorageWatch } from '@/store/useStorageWatch';
import { useAgentAccess } from '@/store/useAgentAccess';
import { AgentIntro } from '@/components/agent/AgentIntro';
import { ExtensionIdValue } from '@/components/agent/ExtensionIdValue';
import { sendBg, onLumoEvent } from '@/lib/messages';
import type { BackupData } from '@/lib/backup';
import { BackupError, parseBackupJson, summarizeBackup } from '@/lib/backup-format';
import { formatBytes, cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import { isImeComposing } from '@/lib/keyboard';
import { DEFAULT_RUN_AT_VALUES, INJECT_INTO_OPTIONS, RUN_AT_OPTIONS } from '@/lib/script/metadata-options';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { SettingRow } from '@/components/settings/SettingRow';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EnumValue } from '@/components/ui/enum';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { SectionNav } from '@/components/layout/SectionNav';
import { Skeleton } from '@/components/ui/skeleton';
import { Segmented } from '@/components/ui/segmented';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isExtensionId } from '@/lib/agent/protocol';
import { removeAllowedClient, upsertAllowedClient } from '@/lib/agent/allowlist';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type SettingsSection = 'general' | 'updates' | 'data' | 'agent';

const RUN_AT = RUN_AT_OPTIONS.filter((option) => DEFAULT_RUN_AT_VALUES.includes(option.value));
const INJECT_INTO = INJECT_INTO_OPTIONS;
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
const LOG_LEVEL_KEYS: Record<(typeof LOG_LEVELS)[number], TranslationKey> = {
  error: 'settings.logLevels.error',
  warn: 'settings.logLevels.warn',
  info: 'settings.logLevels.info',
  debug: 'settings.logLevels.debug',
};
const RUNTIME_ERROR_KEYS: Record<UserScriptsAvailabilityCode, TranslationKey> = {
  'api-unavailable': 'settings.runtimeErrors.api-unavailable',
  'unexpected-result': 'settings.runtimeErrors.unexpected-result',
  disabled: 'settings.runtimeErrors.disabled',
};

interface BackupStats {
  scripts: number;
  trash: number;
  values: number;
  resources: number;
  codeBytes: number;
}

interface ImportResult {
  imported: number;
  skipped: number;
  settingsImported: boolean;
  failed: {
    name: string;
    message: string;
    code?: string;
    params?: Record<string, unknown>;
  }[];
}

type ImportConflict = 'overwrite' | 'skip';

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
  const errorText = useErrorText();
  const toast = useToast();
  const [settings, setSettings] = useState<UISettings | null>(null);
  const [agent, setAgent] = useState<AgentSettings | null>(null);
  // Refs mirror the last optimistic state so a burst of writes never starts
  // from a stale render closure. Writes are serialized below.
  const settingsRef = useRef<UISettings | null>(null);
  const agentRef = useRef<AgentSettings | null>(null);
  const settingsWriteChain = useRef<Promise<void>>(Promise.resolve());
  const agentWriteChain = useRef<Promise<void>>(Promise.resolve());
  const [agentName, setAgentName] = useState('');
  const [agentId, setAgentId] = useState('');
  // Adding a client is its own surface: the allowlist group lists, the dialog
  // creates. A draft survives a dismiss (a pasted 32-char ID is expensive to
  // retype) but is cleared once the entry is accepted.
  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [audit, setAudit] = useState<AgentAuditEntry[]>([]);
  // Same queue the approval dialog renders; the inline list is the durable
  // entry point for users who turned automatic prompting off.
  const agentAccess = useAgentAccess();
  const pendingRequests = agentAccess.actionable;
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backupStats, setBackupStats] = useState<BackupStats | null>(null);
  const [backupPreview, setBackupPreview] = useState<{ data: BackupData; fileName: string } | null>(
    null,
  );
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState<
    'read' | 'export-zip' | 'export-json' | 'import' | null
  >(null);
  const [draggingBackup, setDraggingBackup] = useState(false);
  const [importConflict, setImportConflict] = useState<ImportConflict>('overwrite');
  const [importSettings, setImportSettings] = useState(true);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const applySettings = useCallback((next: UISettings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const applyAgent = useCallback((next: AgentSettings) => {
    agentRef.current = next;
    setAgent(next);
  }, []);

  const loadRuntime = useCallback(async () => {
    try {
      setRuntime(await sendBg<RuntimeStatus>('runtime:status'));
    } catch (e) {
      setError(errorText(e));
    }
  }, [errorText]);

  useEffect(() => {
    storage
      .getUISettings()
      .then(applySettings)
      .catch((e: Error) => setError(errorText(e)));
    storage
      .getAgentSettings()
      .then(applyAgent)
      .catch((e: Error) => setError(errorText(e)));
    void loadRuntime();
  }, [applyAgent, applySettings, errorText, loadRuntime]);

  const loadBackupStats = useCallback(async () => {
    try {
      setBackupStats(await sendBg<BackupStats>('backup:stats'));
    } catch (e) {
      setError(errorText(e));
    }
  }, [errorText]);

  useEffect(() => {
    if (section !== 'data') return;
    void loadBackupStats();
  }, [section, loadBackupStats]);

  useEffect(
    () =>
      onLumoEvent((event) => {
        if (event !== 'scripts-changed') return;
        void loadRuntime();
        if (section === 'data') void loadBackupStats();
      }),
    [loadBackupStats, loadRuntime, section],
  );

  useStorageWatch<UISettings>('uiSettings', (next) => {
    if (next) applySettings(next);
  });

  useStorageWatch<AgentSettings>('agentSettings', (next) => {
    if (next) applyAgent(next);
  });

  /**
   * Optimistic write with a serialized commit queue.
   *
   * `chrome.storage.local` has no compare-and-swap: two handlers that both read
   * the same `settings` object can finish out of order and silently drop the
   * earlier change. The ref gives every handler the newest optimistic value,
   * and the chain guarantees the writes themselves land in the same order.
   */
  const update = (patch: Partial<UISettings>): Promise<void> => {
    const current = settingsRef.current ?? settings;
    if (!current) return Promise.resolve();
    const next = { ...current, ...patch };
    applySettings(next);
    setError(null);

    const task = async () => {
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
        setError(errorText(e));
        // Reconcile with what actually persisted; do not leave the UI
        // advertising a value the write rejected.
        const persisted = await storage.getUISettings().catch(() => null);
        if (persisted) applySettings(persisted);
      }
    };

    settingsWriteChain.current = settingsWriteChain.current.then(task, task);
    return settingsWriteChain.current;
  };

  const updateAgent = (patch: Partial<AgentSettings>): Promise<void> => {
    const current = agentRef.current ?? agent;
    if (!current) return Promise.resolve();
    const next = { ...current, ...patch };
    applyAgent(next);
    setError(null);

    const task = async () => {
      try {
        await storage.setAgentSettings(next);
        toast({ title: t('settings.saved'), variant: 'success' });
      } catch (e) {
        setError(errorText(e));
        const persisted = await storage.getAgentSettings().catch(() => null);
        if (persisted) applyAgent(persisted);
      }
    };

    agentWriteChain.current = agentWriteChain.current.then(task, task);
    return agentWriteChain.current;
  };

  const addAllowedId = (): boolean => {
    const id = agentId.trim();
    if (!isExtensionId(id)) {
      setAddError(t('settings.agent.invalidId'));
      return false;
    }
    // The ID is the identity; the name is an optional label the user can supply
    // when the host has never identified itself. Re-adding an existing ID with a
    // name edits that entry instead of silently doing nothing.
    const name = agentName.trim().slice(0, 80);
    void updateAgent({
      allowedClients: upsertAllowedClient(agent?.allowedClients ?? [], {
        id,
        ...(name ? { name } : {}),
      }),
    });
    setAgentName('');
    setAgentId('');
    setAddError(null);
    return true;
  };

  const loadAudit = useCallback(async () => {
    try {
      setAudit(await sendBg<AgentAuditEntry[]>('agent:audit', { limit: 8 }));
    } catch {
      // Audit is diagnostic; a failure here must not break the settings page.
    }
  }, []);

  useEffect(() => {
    if (section !== 'agent') return;
    void loadAudit();
  }, [section, loadAudit]);

  const approveRequest = async (id: string) => {
    try {
      await agentAccess.approve(id);
      toast({ title: t('settings.agent.approved'), variant: 'success' });
    } catch (e) {
      setError(errorText(e));
    }
  };

  const dismissRequest = async (id: string) => {
    try {
      await agentAccess.dismiss(id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const describeBackupError = (error: unknown): string => {
    if (error instanceof BackupError) {
      switch (error.code) {
        case 'zip-missing-manifest':
          return t('settings.backupErrors.zipMissingManifest');
        case 'invalid-format':
          return t('settings.backupErrors.invalidFormat');
        case 'invalid-json':
          return t('settings.backupErrors.invalidJson');
        default:
          return t('settings.backupErrors.invalidShape');
      }
    }
    // Errors crossing the runtime message boundary lose their class, so the
    // service worker's coded failures arrive as plain strings.
    const message = errorText(error);
    if (message === 'zip-missing-manifest') return t('settings.backupErrors.zipMissingManifest');
    if (message === 'invalid-format') return t('settings.backupErrors.invalidFormat');
    if (message === 'invalid-json') return t('settings.backupErrors.invalidJson');
    if (message === 'invalid-shape') return t('settings.backupErrors.invalidShape');
    return message;
  };

  const exportBackup = async (format: 'json' | 'zip') => {
    setBackupError(null);
    setBackupBusy(format === 'zip' ? 'export-zip' : 'export-json');
    try {
      const data = await sendBg<BackupData>('backup:export');
      const { createBackupZip } = await import('@/lib/backup');
      const date = new Date().toISOString().slice(0, 10);
      const blob =
        format === 'zip'
          ? new Blob([new Uint8Array(createBackupZip(data))], {
              type: 'application/zip',
            })
          : new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `lumo-userscripts-${date}.${format}`;
      anchor.click();
      URL.revokeObjectURL(href);
      toast({ title: t('settings.exportDone'), variant: 'success' });
    } catch (e) {
      setBackupError(describeBackupError(e));
    } finally {
      setBackupBusy(null);
    }
  };

  /** Read and validate first, then ask. Importing straight from the picker made
   *  a same-name conflict or a settings overwrite impossible to see before it
   *  had already happened. */
  const readBackupFile = async (file: File | undefined) => {
    if (!file) return;
    setBackupError(null);
    setBackupBusy('read');
    try {
      // Sniff the ZIP magic instead of trusting the extension: a backup renamed
      // to .json (or a zip served with the wrong name) should still restore.
      const buffer = await file.arrayBuffer();
      const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
      const isZip = head[0] === 0x50 && head[1] === 0x4b;
      const { readBackupZip } = await import('@/lib/backup');
      const data = isZip
        ? readBackupZip(buffer)
        : parseBackupJson(new TextDecoder().decode(buffer));
      setImportConflict('overwrite');
      setImportSettings(true);
      setImportResult(null);
      setBackupPreview({ data, fileName: file.name });
    } catch (e) {
      setBackupError(describeBackupError(e));
    } finally {
      setBackupBusy(null);
    }
  };

  const runImport = async () => {
    if (!backupPreview) return;
    setBackupError(null);
    setBackupBusy('import');
    try {
      const result = await sendBg<ImportResult>('backup:import', {
        data: backupPreview.data,
        options: { conflict: importConflict, importSettings },
      });
      setImportResult(result);
      await loadBackupStats();
      await loadRuntime();
    } catch (e) {
      setBackupError(describeBackupError(e));
    } finally {
      setBackupBusy(null);
    }
  };

  // Sections are document tabs, not page actions: they sit under the title and
  // are shaped like tabs, so the action slot stays reserved for actions.
  const header = (
    <>
      <PageHeader title={t('settings.title')} />
      <SectionNav
        ariaLabel={t('settings.title')}
        value={section}
        onChange={onNavigate}
        items={[
          { value: 'general', label: t('settings.sections.general') },
          { value: 'updates', label: t('settings.sections.updates') },
          { value: 'data', label: t('settings.sections.data') },
          { value: 'agent', label: t('settings.sections.agent') },
        ]}
      />
    </>
  );

  const previewSummary = backupPreview ? summarizeBackup(backupPreview.data) : null;

  const formatBackupDate = (value?: string) => {
    if (!value) return '—';
    const time = Date.parse(value);
    return Number.isFinite(time) ? formatDateTime(time, i18n.language) : '—';
  };

  const closePreview = () => {
    if (backupBusy === 'import') return;
    setBackupPreview(null);
    setImportResult(null);
    setBackupError(null);
  };

  if (!settings) {
    return (
      <PageLayout header={header} width="form">
        <Skeleton className="mb-2.5 h-4 w-24" />
        <div className="divide-y divide-border/70 rounded-card border border-border bg-card px-4 shadow-surface">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="py-3">
              <Skeleton className="h-3.5 w-1/3" />
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
                  <SelectTrigger className="w-64 max-w-full" aria-label={t('settings.defaultRunAt')}>
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
                  <SelectTrigger
                    className="w-64 max-w-full"
                    aria-label={t('settings.defaultInjectInto')}
                  >
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

          {/* Runtime health is a settings group like its neighbours — same
              heading, same surface — with the status where a group keeps its
              action, instead of a one-off card with its own anatomy. */}
          <SettingsGroup
            title={t('settings.runtime')}
            description={t('settings.runtimeHint')}
            action={
              <Badge variant={runtime?.userScriptsAvailable ? 'success' : 'destructive'}>
                <ShieldCheck className="h-3 w-3" />
                {runtime?.userScriptsAvailable
                  ? t('settings.runtimeAvailable')
                  : t('settings.runtimeUnavailable')}
              </Badge>
            }
          >
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 py-3 sm:grid-cols-3">
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
              <p className="whitespace-pre-wrap break-words py-2.5 text-2xs leading-relaxed text-destructive">
                {runtime.lastErrorCode
                  ? t(RUNTIME_ERROR_KEYS[runtime.lastErrorCode])
                  : runtime.lastError}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 py-2.5">
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
          </SettingsGroup>

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
                  <SelectTrigger className="w-64 max-w-full" aria-label={t('settings.logLevel')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOG_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        <EnumValue label={t(LOG_LEVEL_KEYS[level])} raw={level} />
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

      {section === 'agent' && agent && (
        <>
          {/* Stays only while nothing is connected: once a client is on the
              allowlist the explanation is spent, and a permanent banner above
              the switches would be pure chrome. */}
          {agent.allowedClients.length === 0 && <AgentIntro />}

          {pendingRequests.length > 0 && (
            <SettingsGroup
              title={t('settings.agent.requests')}
              description={t('settings.agent.requestsHint')}
            >
              {pendingRequests.map((request) => (
                <div
                  key={request.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0 flex-1 basis-52">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <p className="min-w-0 truncate text-sm font-medium">
                        {request.name || t('settings.agent.unknownClient')}
                      </p>
                      {request.version && (
                        <Badge variant="outline">{request.version}</Badge>
                      )}
                    </div>
                    <code className="mt-0.5 block select-all truncate font-mono text-2xs text-muted-foreground" dir="ltr">
                      {request.id}
                    </code>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" onClick={() => void approveRequest(request.id)}>
                      {t('settings.agent.approve')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void dismissRequest(request.id)}
                    >
                      {t('settings.agent.dismiss')}
                    </Button>
                  </div>
                </div>
              ))}
            </SettingsGroup>
          )}

          <SettingsGroup title={t('settings.groups.agent')}>
            <SettingRow
              label={t('settings.agent.enabled')}
              description={t('settings.agent.enabledHint')}
              control={
                <Switch
                  checked={agent.enabled}
                  onCheckedChange={(checked) => void updateAgent({ enabled: checked })}
                  aria-label={t('settings.agent.enabled')}
                />
              }
            />
            <SettingRow
              label={t('settings.agent.promptOnRequest')}
              description={t('settings.agent.promptOnRequestHint')}
              control={
                <Switch
                  checked={agent.promptOnRequest}
                  onCheckedChange={(checked) => void updateAgent({ promptOnRequest: checked })}
                  aria-label={t('settings.agent.promptOnRequest')}
                />
              }
            />
          </SettingsGroup>

          {agent.enabled && (
            <>
              <SettingsGroup title={t('settings.agent.writes')}>
                <SettingRow
                  label={t('settings.agent.allowWrites')}
                  description={t('settings.agent.allowWritesHint')}
                  control={
                    <Switch
                      checked={agent.allowWrites}
                      onCheckedChange={(checked) => void updateAgent({ allowWrites: checked })}
                      aria-label={t('settings.agent.allowWrites')}
                    />
                  }
                />
                {agent.allowWrites && (
                  <SettingRow
                    label={t('settings.agent.reviewWrites')}
                    control={
                      <Switch
                        checked={agent.reviewWrites}
                        onCheckedChange={(checked) => void updateAgent({ reviewWrites: checked })}
                        aria-label={t('settings.agent.reviewWrites')}
                      />
                    }
                  />
                )}
              </SettingsGroup>

              <SettingsGroup
                title={t('settings.agent.allowed')}
                description={t('settings.agent.allowedHint')}
                action={
                  <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('settings.agent.add')}
                  </Button>
                }
              >
                {agent.allowedClients.length === 0 ? (
                  <p className="py-2.5 text-xs text-muted-foreground">
                    {t('settings.agent.noAllowed')}
                  </p>
                ) : (
                  agent.allowedClients.map((client) => (
                    <div key={client.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <p
                            dir="auto"
                            className={cn(
                              'min-w-0 truncate',
                              client.name
                                ? 'text-sm font-medium text-foreground'
                                : 'font-mono text-xs text-muted-foreground',
                            )}
                          >
                            {client.name ?? client.id}
                          </p>
                          {client.version && <Badge variant="outline">{client.version}</Badge>}
                        </div>
                        {client.name && (
                          <code className="mt-0.5 block select-all truncate font-mono text-2xs text-muted-foreground" dir="ltr">
                            {client.id}
                          </code>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() =>
                          void updateAgent({
                            allowedClients: removeAllowedClient(agent.allowedClients, client.id),
                          })
                        }
                        aria-label={t('settings.agent.remove')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))
                )}
              </SettingsGroup>

              <Dialog
                open={addOpen}
                onOpenChange={(next) => {
                  setAddOpen(next);
                  if (!next) setAddError(null);
                }}
              >
                <DialogContent className="sm:max-w-sm" closeLabel={t('common.close')}>
                  <form
                    className="flex min-w-0 flex-col gap-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (addAllowedId()) setAddOpen(false);
                    }}
                  >
                    <DialogHeader>
                      <DialogTitle>{t('settings.agent.add')}</DialogTitle>
                      <DialogDescription>{t('settings.agent.allowedHint')}</DialogDescription>
                    </DialogHeader>

                    {/* Enter during IME composition is a candidate selection,
                        not a submit; the guard lives on the inputs so no extra
                        interactive wrapper is needed. */}
                    <div className="flex min-w-0 flex-col gap-3">
                      <Field label={t('settings.agent.namePlaceholder')}>
                        {(props) => (
                          <Input
                            {...props}
                            value={agentName}
                            onChange={(event) => setAgentName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && isImeComposing(event)) {
                                event.preventDefault();
                              }
                            }}
                            dir="auto"
                            className="text-sm"
                            maxLength={80}
                          />
                        )}
                      </Field>
                      <Field
                        label={t('settings.agent.idPlaceholder')}
                        required
                        error={addError ?? undefined}
                      >
                        {(props) => (
                          <Input
                            {...props}
                            value={agentId}
                            onChange={(event) => {
                              setAgentId(event.target.value);
                              if (addError) setAddError(null);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && isImeComposing(event)) {
                                event.preventDefault();
                              }
                            }}
                            dir="ltr"
                            className="font-mono text-sm"
                            spellCheck={false}
                            autoFocus
                          />
                        )}
                      </Field>
                    </div>

                    <DialogFooter>
                      <Button type="button" variant="ghost" onClick={() => setAddOpen(false)}>
                        {t('common.cancel')}
                      </Button>
                      <Button type="submit" disabled={!agentId.trim()}>
                        <Plus className="h-3.5 w-3.5" />
                        {t('settings.agent.add')}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>

              <SettingsGroup title={t('settings.agent.identity')}>
                <div className="py-3">
                  <p className="text-sm font-medium leading-5 text-foreground">
                    {t('settings.agent.extensionId')}
                  </p>
                  <p className="mt-0.5 max-w-[62ch] text-xs leading-relaxed text-muted-foreground text-pretty">
                    {t('settings.agent.extensionIdHint')}
                  </p>
                  <ExtensionIdValue className="mt-2" />
                </div>
              </SettingsGroup>

              <SettingsGroup
                title={t('settings.agent.activity')}
                action={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void loadAudit()}
                    aria-label={t('settings.agent.activityRefresh')}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                }
              >
                {audit.length === 0 ? (
                  <p className="py-2.5 text-xs text-muted-foreground">
                    {t('settings.agent.activityEmpty')}
                  </p>
                ) : (
                  audit.map((entry) => (
                    <div
                      key={entry.id ?? `${entry.time}-${entry.tool}`}
                      className="flex items-start gap-2 py-2"
                    >
                      <Badge variant={entry.result === 'ok' ? 'success' : 'destructive'}>
                        {entry.tool}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-2xs text-muted-foreground">
                          {entry.targetUuid ?? '—'}
                        </p>
                        <p className="text-2xs tabular-nums text-muted-foreground">
                          {formatDateTime(entry.time, i18n.language)}
                        </p>
                        {entry.message && (
                          <p className="break-words text-2xs text-destructive">{entry.message}</p>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </SettingsGroup>
            </>
          )}
        </>
      )}

      {section === 'data' && (
        <>
          <SettingsGroup
            title={t('settings.groups.overview')}
            description={t('settings.dataHint')}
          >
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 py-3 sm:grid-cols-3">
              <Stat
                label={t('settings.overviewScripts')}
                value={backupStats?.scripts ?? '—'}
              />
              <Stat label={t('settings.overviewTrash')} value={backupStats?.trash ?? '—'} />
              <Stat label={t('settings.overviewValues')} value={backupStats?.values ?? '—'} />
              <Stat
                label={t('settings.overviewResources')}
                value={backupStats?.resources ?? '—'}
              />
              <Stat
                label={t('settings.overviewCodeSize')}
                value={backupStats ? formatBytes(backupStats.codeBytes, i18n.language) : '—'}
              />
            </dl>
          </SettingsGroup>

          <SettingsGroup title={t('settings.groups.export')} description={t('settings.exportHint')}>
            <SettingRow
              label={t('settings.exportZip')}
              description={t('settings.exportZipHint')}
              control={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={backupBusy !== null}
                  onClick={() => void exportBackup('zip')}
                >
                  {backupBusy === 'export-zip' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <FileArchive className="h-3.5 w-3.5" />
                  )}
                  {t('settings.export')}
                </Button>
              }
            />
            <SettingRow
              label={t('settings.exportJson')}
              description={t('settings.exportJsonHint')}
              control={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={backupBusy !== null}
                  onClick={() => void exportBackup('json')}
                >
                  {backupBusy === 'export-json' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <FileJson className="h-3.5 w-3.5" />
                  )}
                  {t('settings.export')}
                </Button>
              }
            />
          </SettingsGroup>

          <SettingsGroup
            title={t('settings.groups.restore')}
            description={t('settings.importHint')}
          >
            <div className="py-3">
              {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- drag/drop is pointer-only; the Choose button inside is the keyboard path. */}
              <div
                className={cn(
                  'rounded-card border border-dashed px-4 py-5 text-center transition-colors duration-150 ease-standard',
                  draggingBackup
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-muted/20',
                )}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDraggingBackup(true);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDraggingBackup(false);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDraggingBackup(false);
                  void readBackupFile(event.dataTransfer.files?.[0]);
                }}
              >
                {backupBusy === 'read' ? (
                  <Loader2 className="mx-auto h-5 w-5 animate-spin motion-reduce:animate-none text-muted-foreground" />
                ) : (
                  <FileArchive className="mx-auto h-5 w-5 text-muted-foreground" />
                )}
                <p className="mt-2 text-sm font-medium text-foreground">
                  {backupBusy === 'read'
                    ? t('settings.importReading')
                    : t('settings.importDrop')}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  disabled={backupBusy !== null}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" />
                  {t('settings.importChoose')}
                </Button>
              </div>
              {backupError && !backupPreview && (
                <p
                  role="alert"
                  className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive"
                >
                  {backupError}
                </p>
              )}
            </div>
          </SettingsGroup>

          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json,.zip"
            className="hidden"
            onChange={(event) => {
              void readBackupFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />

          <Dialog
            open={backupPreview !== null}
            onOpenChange={(open) => {
              if (!open) closePreview();
            }}
          >
            <DialogContent className="sm:max-w-md" closeLabel={t('common.close')}>
              <DialogHeader>
                <DialogTitle>
                  {importResult
                    ? t('settings.importResultTitle')
                    : t('settings.importPreviewTitle')}
                </DialogTitle>
                <DialogDescription className="truncate font-mono text-2xs">
                  {backupPreview?.fileName}
                </DialogDescription>
              </DialogHeader>

              {backupPreview && !importResult && previewSummary && (
                <div className="space-y-3">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-card border border-border bg-muted/30 px-3 py-2.5">
                    <BackupMeta
                      label={t('settings.importExportedAt')}
                      value={formatBackupDate(backupPreview.data.exportedAt)}
                    />
                    <BackupMeta
                      label={t('settings.importFormat')}
                      value={`v${backupPreview.data.version ?? 1}`}
                    />
                    <BackupMeta
                      label={t('settings.importScriptCount')}
                      value={String(previewSummary.scripts)}
                    />
                    <BackupMeta
                      label={t('settings.importValues')}
                      value={String(previewSummary.values)}
                    />
                    <BackupMeta
                      label={t('settings.importResources')}
                      value={String(previewSummary.resources)}
                    />
                    <BackupMeta
                      label={t('settings.importIncludesSettings')}
                      value={previewSummary.hasSettings ? t('common.yes') : t('common.no')}
                    />
                  </dl>

                  <p className="text-xs text-muted-foreground">
                    {t('settings.importStateBreakdown', {
                      enabled: previewSummary.enabled,
                      disabled: previewSummary.disabled,
                      trash: previewSummary.trash,
                    })}
                  </p>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="text-sm font-medium text-foreground">
                        {t('settings.importConflict')}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {t('settings.importConflictHint')}
                      </p>
                    </div>
                    <Segmented
                      size="sm"
                      ariaLabel={t('settings.importConflict')}
                      value={importConflict}
                      onChange={setImportConflict}
                      options={[
                        {
                          value: 'overwrite',
                          label: t('settings.importConflictOverwrite'),
                        },
                        { value: 'skip', label: t('settings.importConflictSkip') },
                      ]}
                    />
                  </div>

                  {previewSummary.hasSettings && (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0 flex-1 basis-40">
                        <label
                          htmlFor="import-settings"
                          className="text-sm font-medium text-foreground"
                        >
                          {t('settings.importSettingsToggle')}
                        </label>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                          {t('settings.importSettingsHint')}
                        </p>
                      </div>
                      <Switch
                        id="import-settings"
                        checked={importSettings}
                        onCheckedChange={setImportSettings}
                        aria-label={t('settings.importSettingsToggle')}
                      />
                    </div>
                  )}
                </div>
              )}

              {importResult && (
                <div className="space-y-2" role="status">
                  <p className="text-sm text-foreground">
                    {t('settings.importResultSummary', {
                      imported: importResult.imported,
                      skipped: importResult.skipped,
                      failed: importResult.failed.length,
                    })}
                  </p>
                  {importResult.settingsImported && (
                    <p className="text-xs text-muted-foreground">
                      {t('settings.importResultSettings')}
                    </p>
                  )}
                  {importResult.failed.length > 0 && (
                    <div className="max-h-40 overflow-y-auto scrollbar-lumo rounded-card border border-destructive/25 bg-destructive/5 px-2 py-1">
                      {importResult.failed.map((failure, index) => (
                        <div
                          key={`${failure.name}-${index}`}
                          className="border-b border-destructive/15 py-1.5 last:border-b-0"
                        >
                          <p className="truncate text-2xs font-medium text-foreground">
                            {failure.name}
                          </p>
                          <p className="whitespace-pre-wrap break-words text-2xs text-destructive">
                            {errorText(
                              appErrorFromResponse(failure.code, failure.message, failure.params),
                            )}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {backupError && backupPreview && (
                <p
                  role="alert"
                  className="whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive"
                >
                  {backupError}
                </p>
              )}

              <DialogFooter>
                {importResult ? (
                  <Button onClick={closePreview}>{t('common.close')}</Button>
                ) : (
                  <>
                    <Button variant="ghost" onClick={closePreview} disabled={backupBusy === 'import'}>
                      {t('common.cancel')}
                    </Button>
                    <Button
                      onClick={() => void runImport()}
                      disabled={
                        backupBusy !== null || !previewSummary || previewSummary.scripts === 0
                      }
                    >
                      {backupBusy === 'import' && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                      {t('settings.importAction', { count: previewSummary?.scripts ?? 0 })}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </PageLayout>
  );
}

function BackupMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd
        className="mt-0.5 truncate text-xs font-medium tabular-nums text-foreground"
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
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
          if (event.key !== 'Enter' || isImeComposing(event)) return;
          event.preventDefault();
          commit();
        }}
        className="w-20 text-end tabular-nums"
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}
