import type { ScriptMetadata, UISettings } from '@/types';
import {
  findByNameNamespace,
  getAll,
  getDraft,
  getScript,
  listLogs,
  clearLogs,
  countLogsSince,
  clearStore,
  replaceResources,
  cleanupDrafts,
  listAgentAudit,
} from '@/lib/db';
import { parseMetadata } from '@/lib/script/metadata';
import { validateBackupData } from '@/lib/backup-format';
import { storage } from '@/store/storage';
import { getValuesForScript, setValueForScript, deleteValueForScript } from '@/lib/background/values';
import {
  listMenuCommands,
  clearMenuCommands,
  dropMenuFrame,
  menuRouteFrames,
} from '@/lib/background/menus';
import {
  registerHostPort,
  sendToHost,
  clearHostPortsForTab,
  onHostPortClosed,
} from '@/lib/background/host-ports';
import {
  onDownloadChanged,
  onNotificationButtonClicked,
  onNotificationClicked,
  onNotificationClosed,
  onTabRemoved,
} from '@/lib/background/gm';
import {
  createHostContext,
  handleHostRequest,
  HostError,
} from '@/lib/background/host-service';
import { broadcast } from '@/lib/background/events';
import {
  commitInstall,
  destroyScript,
  getAllScripts,
  getEditorDetail,
  getManagerScripts,
  getPopupData,
  getScriptDetail,
  prepareInstall,
  removeScript,
  restoreDeletedScript,
  saveScriptFromCode,
  toggleScript,
  updateSelfMetadata,
} from '@/lib/background/scripts';
import {
  checkScriptUpdates,
  isUpdateAlarm,
  setupUpdateAlarm,
} from '@/lib/background/updates';
import {
  checkUserScriptsAvailable,
  getRuntimeStatus,
  requestRegistration,
} from '@/lib/background/registry';
import {
  forgetBadge,
  refreshAllBadges,
  refreshBadge,
  requestBadgeRefresh,
} from '@/lib/background/badge';
import {
  forgetInjectedState,
  resetFrameInjectedState,
  resetTabInjectedState,
} from '@/lib/background/injected-state';
import { createAgentMcpServer } from '@/lib/agent/mcp-server';
import { resolveAgentAccess } from '@/lib/agent/policy';
import {
  approvePendingRequest,
  dismissPendingRequest,
} from '@/lib/agent/pending';
import { handleProbe } from '@/lib/agent/probe';
import { isProbeRequest, MCP_PORT_NAME } from '@/lib/agent/protocol';
import { ChromePortTransport } from '@/lib/agent/transport';
import { openOptionsTab } from '@/lib/options-tab';

const INSTALL_RULE_ID = 1;

async function installRedirectRules(): Promise<void> {
  const installUrl = chrome.runtime.getURL('install.html');
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [INSTALL_RULE_ID],
      addRules: [
        {
          id: INSTALL_RULE_ID,
          priority: 1,
          action: {
            type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
            redirect: { regexSubstitution: `${installUrl}?src=\\1` },
          },
          condition: {
            regexFilter: '^(https?://[^\\s#]+\\.user\\.js(?:[?][^\\s#]*)?)(?:#.*)?$',
            isUrlFilterCaseSensitive: false,
            resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
            requestMethods: [chrome.declarativeNetRequest.RequestMethod.GET],
          },
        },
      ],
    });
  } catch (error) {
    console.error('[Lumo Userscripts] Failed to install DNR redirect:', error);
  }
}

async function bootstrapRuntime(): Promise<void> {
  await installRedirectRules();
  await cleanupDrafts();
  await setupUpdateAlarm();
  await requestRegistration();
}

function sendBgResult(
  port: chrome.runtime.Port,
  id: string,
  result?: unknown,
  error?: string,
  code?: string,
) {
  try {
    port.postMessage({ type: 'bg:result', id, result, error, code });
  } catch {
    // The bridge frame navigated away while the request was in flight.
  }
}

function handleHostPort(port: chrome.runtime.Port, sender: chrome.runtime.MessageSender) {
  const record = registerHostPort(port, sender);
  if (!record) return;

  port.onMessage.addListener((message: any) => {
    const type = String(message?.type ?? '');
    const id = String(message?.id ?? '');
    // The event channel's keep-alive messages are not RPCs and have no id.
    if (type === 'host:ready') {
      const url = String((message?.payload ?? {}).url ?? '');
      if (url) record.url = url;
      return;
    }
    if (!id && type === 'host:ping') return;
    const payload = (message?.payload ?? {}) as Record<string, unknown>;
    const ctx = createHostContext(
      {
        tab: { id: record.tabId, url: record.url } as chrome.tabs.Tab,
        frameId: record.frameId,
        url: record.url,
      },
      payload,
    );
    void handleHostRequest(type, payload, ctx).then(
      (result) => sendBgResult(port, id, result),
      (error) =>
        sendBgResult(
          port,
          id,
          undefined,
          error instanceof Error ? error.message : String(error),
          error instanceof HostError ? error.code : 'HOST_FAILED',
        ),
    );
  });
}

async function handleRuntimeMessage(
  message: any,
  sender?: chrome.runtime.MessageSender,
): Promise<unknown> {
  const type = String(message?.type ?? '');
  const payload = (message?.payload ?? {}) as Record<string, any>;

  if (type.startsWith('host:') && type !== 'host:wake') {
    return handleHostRequest(type, payload, createHostContext(sender, payload));
  }

  switch (type) {
    case 'host:wake':
      return true;
    case 'options:open':
      await openOptionsTab(String(payload.hash ?? ''));
      return true;
    case 'popup:getData': {
      const data = await getPopupData(Number(payload.tabId ?? -1), payload.url);
      const availability = await checkUserScriptsAvailable();
      return {
        ...data,
        runtime: {
          ...data.runtime,
          userScriptsAvailable: availability.ok,
          lastError: availability.ok ? data.runtime.lastError : availability.error,
        },
      };
    }
    case 'scripts:list':
      return getManagerScripts(Boolean(payload.includeRemoved));
    case 'scripts:getDetail':
      return getEditorDetail(String(payload.uuid ?? ''));
    case 'scripts:save':
      return saveScriptFromCode(
        payload.uuid ? String(payload.uuid) : null,
        String(payload.code ?? ''),
        String(payload.sourceUrl ?? ''),
      );
    case 'scripts:updateMetadata':
      return updateSelfMetadata(String(payload.uuid ?? ''), payload.selfMetadata as ScriptMetadata);
    case 'scripts:toggle':
      await toggleScript(String(payload.uuid ?? ''), Boolean(payload.enabled));
      return true;
    case 'scripts:delete':
      await removeScript(String(payload.uuid ?? ''));
      return true;
    case 'scripts:restore':
      await restoreDeletedScript(String(payload.uuid ?? ''));
      return true;
    case 'scripts:purge':
      await destroyScript(String(payload.uuid ?? ''));
      return true;
    case 'install:prepare':
      return prepareInstall({
        sourceUrl: payload.sourceUrl ? String(payload.sourceUrl) : undefined,
        code: payload.code ? String(payload.code) : undefined,
      });
    case 'install:commit':
      return commitInstall(String(payload.token ?? ''), { enabled: payload.enabled !== false });
    case 'install:getDraft': {
      const draft = await getDraft(String(payload.token ?? ''));
      if (!draft) return null;
      const { resourceRecords: _resourceRecords, ...summary } = draft;
      return summary;
    }
    case 'runtime:status': {
      const availability = await checkUserScriptsAvailable();
      const current = getRuntimeStatus();
      return {
        ...current,
        userScriptsAvailable: availability.ok,
        lastError: availability.ok ? current.lastError : availability.error,
      };
    }
    case 'runtime:refresh':
      return requestRegistration();
    case 'menus:list':
      return listMenuCommands(Number(payload.tabId ?? -1));
    case 'menus:invoke': {
      const tabId = Number(payload.tabId ?? -1);
      const uuid = String(payload.uuid ?? '');
      const id = String(payload.id ?? '');
      const preferred = payload.frameId === undefined ? undefined : Number(payload.frameId);
      // A command may be registered in several frames; deliver it to the first
      // one that still has a live port so an iframe-only command stays usable.
      for (const frameId of menuRouteFrames(tabId, uuid, id, preferred)) {
        if (
          sendToHost(tabId, frameId, {
            type: 'bg:event',
            event: 'menu-command',
            payload: { uuid, id },
          })
        ) {
          return true;
        }
      }
      return false;
    }
    case 'updates:check':
      return checkScriptUpdates(payload.uuid ? String(payload.uuid) : undefined);
    case 'updates:setup':
      await setupUpdateAlarm();
      return true;
    case 'values:list':
      return getValuesForScript(String(payload.uuid ?? ''));
    case 'values:set':
      await setValueForScript(String(payload.uuid ?? ''), String(payload.key ?? ''), payload.value);
      return true;
    case 'values:delete':
      await deleteValueForScript(String(payload.uuid ?? ''), String(payload.key ?? ''));
      return true;
    case 'logs:list':
      return listLogs(Number(payload.limit ?? 500), payload.uuid ? String(payload.uuid) : undefined);
    case 'logs:clear':
      await clearLogs(payload.uuid ? String(payload.uuid) : undefined);
      broadcast('logs-changed');
      return true;
    case 'logs:unread':
      return { errors: await countLogsSince(await storage.getLogsSeenAt(), 'error') };
    case 'agent:audit':
      return listAgentAudit(Number(payload.limit ?? 20));
    case 'agent:pendingRequests':
      return storage.getAgentPendingRequests();
    case 'agent:approveRequest':
      return approvePendingRequest(String(payload.id ?? ''));
    case 'agent:dismissRequest':
      await dismissPendingRequest(String(payload.id ?? ''));
      return true;
    case 'backup:export':
      return exportBackup();
    case 'backup:stats':
      return backupStats();
    case 'backup:import':
      return importBackup(payload);
    case 'storage:clear':
      await clearStore('logs');
      broadcast('logs-changed');
      return true;
    default:
      throw new Error(`Unknown message: ${type}`);
  }
}

async function exportBackup(): Promise<Record<string, unknown>> {
  const scripts = await getAllScripts(true);
  const settings = await storage.getUISettings();
  const entries = [];
  for (const script of scripts) {
    const detail = await getScriptDetail(script.uuid);
    if (!detail) continue;
    const values = await getValuesForScript(script.uuid).then((result) => result.values);
    entries.push({
      script,
      code: detail.script.code,
      values,
      resources: detail.resources,
    });
  }
  return {
    format: 'lumo-userscripts',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    scripts: entries,
  };
}

interface BackupStats {
  scripts: number;
  trash: number;
  values: number;
  resources: number;
  codeBytes: number;
}

interface ImportBackupOptions {
  conflict?: 'overwrite' | 'skip';
  importSettings?: boolean;
}

interface ImportBackupResult {
  imported: number;
  skipped: number;
  settingsImported: boolean;
  failed: { name: string; message: string }[];
}

async function backupStats(): Promise<BackupStats> {
  const [scripts, values, resources] = await Promise.all([
    getAllScripts(true),
    getAll<{ storageName: string; key: string }>('values'),
    getAll<unknown>('resources'),
  ]);
  const active = scripts.filter((script) => !script.removedAt);
  return {
    scripts: active.length,
    trash: scripts.length - active.length,
    values: values.length,
    resources: resources.length,
    codeBytes: scripts.reduce((total, script) => total + script.codeSize, 0),
  };
}

async function importBackup(payload: Record<string, any>): Promise<ImportBackupResult> {
  const data = validateBackupData(payload.data);
  const options = (payload.options ?? {}) as ImportBackupOptions;
  const conflict = options.conflict === 'skip' ? 'skip' : 'overwrite';

  let settingsImported = false;
  if (options.importSettings !== false && data.settings && typeof data.settings === 'object') {
    try {
      await storage.importConfig({ uiSettings: data.settings as unknown as UISettings });
      settingsImported = true;
    } catch {
      // A malformed settings block must not abort the script import.
    }
  }

  let imported = 0;
  let skipped = 0;
  const failed: { name: string; message: string }[] = [];

  for (const entry of data.scripts ?? []) {
    let label = entry?.script?.name ?? entry?.script?.uuid ?? 'Script';
    try {
      if (!entry?.script || typeof entry.code !== 'string') {
        throw new Error('The backup entry has no script code.');
      }

      // Parse before touching the database: the name and namespace decide
      // whether this entry overwrites an installed script, and a broken
      // metadata block must be reported as one failure instead of aborting
      // the whole restore.
      const parsed = parseMetadata(entry.code);
      if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
      const name = parsed.metadata.name?.[0] ?? entry.script.name ?? '';
      const namespace = parsed.metadata.namespace?.[0] ?? entry.script.namespace ?? '';
      label = name || label;

      const byUuid = entry.script.uuid ? await getScript(entry.script.uuid) : undefined;
      const byName = await findByNameNamespace(name, namespace);
      const existing = byUuid ?? byName;

      if (existing && conflict === 'skip') {
        skipped += 1;
        continue;
      }

      // Overwriting keeps the installed UUID, so values and resources that are
      // written below land on the record the user already has.
      const record = await saveScriptFromCode(
        existing?.uuid ?? null,
        entry.code,
        String(entry.script.origin ?? ''),
      );

      if (entry.script.selfMetadata) {
        await updateSelfMetadata(
          record.uuid,
          entry.script.selfMetadata as unknown as ScriptMetadata,
        );
      }
      if (entry.values && typeof entry.values === 'object') {
        for (const [key, value] of Object.entries(entry.values)) {
          await setValueForScript(record.uuid, key, value);
        }
      }
      if (Array.isArray(entry.resources)) {
        await replaceResources(
          record.uuid,
          entry.resources.map((resource: any) => ({
            ...resource,
            uuid: record.uuid,
          })),
        );
      }
      if (entry.script.enabled === false) {
        await toggleScript(record.uuid, false);
      }
      if (entry.script.removedAt) {
        await removeScript(record.uuid);
      }
      imported += 1;
    } catch (error) {
      failed.push({
        name: label,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (settingsImported) await setupUpdateAlarm();
  await requestRegistration();
  broadcast('scripts-changed');
  return { imported, skipped, settingsImported, failed };
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void bootstrapRuntime()
      .then(() => checkScriptUpdates())
      .catch((error) => console.error('[Lumo Userscripts] Bootstrap failed:', error));
  });
  chrome.runtime.onStartup.addListener(() => {
    void bootstrapRuntime()
      .then(() => checkScriptUpdates())
      .catch((error) => console.error('[Lumo Userscripts] Bootstrap failed:', error));
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'lumo:bridge') {
      handleHostPort(port, port.sender ?? {});
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handleRuntimeMessage(message, sender).then(
      (result) => sendResponse({ ok: true, result }),
      (error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof HostError ? error.code : 'HOST_FAILED',
        }),
    );
    return true;
  });

  // ─── Agent endpoint (L0 probe + L1 MCP) ───────────────────────────────────
  // Only extensions listed in `agentSettings.allowedExtensionIds` may open an
  // MCP session. `externally_connectable` in the manifest decides who can even
  // reach these listeners; this is the second, authoritative check.
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (!isProbeRequest(message)) return false;
    void handleProbe(message, sender).then(sendResponse, (error) =>
      sendResponse({
        ok: false,
        error: {
          code: 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );
    return true;
  });

  chrome.runtime.onConnectExternal.addListener((port) => {
    if (port.name !== MCP_PORT_NAME) return;
    const transport = new ChromePortTransport(port);
    void (async () => {
      const access = await resolveAgentAccess(port.sender?.id);
      if (!access.enabled || !access.authorized) {
        await transport.close();
        return;
      }
      const server = createAgentMcpServer(port.sender?.id, access.settings);
      transport.onclose = () => {
        void server.close().catch(() => undefined);
      };
      await server.connect(transport);
    })().catch((error) => {
      console.error('[Lumo Userscripts] Agent MCP session failed:', error);
      void transport.close();
    });
  });

  chrome.alarms?.onAlarm?.addListener((alarm) => {
    if (isUpdateAlarm(alarm.name)) void checkScriptUpdates();
  });

  chrome.notifications?.onClicked?.addListener((id) => {
    onNotificationClicked(id);
  });
  chrome.notifications?.onClosed?.addListener((id, byUser) => {
    onNotificationClosed(id, Boolean(byUser));
  });
  chrome.notifications?.onButtonClicked?.addListener((id, index) => {
    onNotificationButtonClicked(id, index);
  });

  chrome.downloads?.onChanged?.addListener((delta) => {
    onDownloadChanged(delta.id, delta);
  });

  chrome.tabs?.onRemoved?.addListener((tabId) => {
    onTabRemoved(tabId);
    clearMenuCommands(tabId);
    clearHostPortsForTab(tabId);
    forgetBadge(tabId);
    void forgetInjectedState(tabId);
  });

  // A frame's port closed: its menu commands can no longer be delivered. The
  // engine replays registrations after a bridge reconnect, so dropping them is
  // safe and keeps the popup free of rows that would fail on click.
  onHostPortClosed((tabId, frameId) => {
    if (dropMenuFrame(tabId, frameId)) {
      broadcast('menus-changed', { tabId });
    }
  });

  // ─── Toolbar badge ────────────────────────────────────────────────────────
  // The badge answers "how many scripts are actually running in the tab in
  // front of me". That answer changes when a script reports a start
  // (`host:run`), when a document commits, or when the script set / settings
  // change — never because a URL merely changed. Chrome keeps badges per tab,
  // so a background tab is recomputed when it becomes active.
  chrome.tabs?.onActivated?.addListener(({ tabId }) => {
    void refreshBadge(tabId);
  });
  chrome.windows?.onFocusChanged?.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    void refreshBadge();
  });
  // Only the settings the badge reads matter here: `uiSettings` is one key, and
  // the appearance panel writes it for font size and language too. Those are
  // global, so a real change has to repaint every open tab, not just the front.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.uiSettings) return;
    const before = changes.uiSettings.oldValue as Partial<UISettings> | undefined;
    const after = changes.uiSettings.newValue as Partial<UISettings> | undefined;
    if (
      before &&
      after &&
      before.showBadge === after.showBadge &&
      before.scriptsEnabled === after.scriptsEnabled &&
      before.accent === after.accent &&
      before.theme === after.theme
    ) {
      return;
    }
    void refreshAllBadges();
  });

  // A commit is the moment Chrome discards a tab's badge and the moment every
  // script of the previous document stops existing. Reset the reported state
  // (and the cached badge text) here, then repaint; the new document's scripts
  // report themselves as they start. Prerendered documents are not in front
  // yet, so their commits must not clear the visible badge.
  chrome.webNavigation?.onCommitted?.addListener((details) => {
    if (details.documentLifecycle && details.documentLifecycle !== 'active') return;
    const report = { documentId: details.documentId, url: details.url };
    if (details.frameId === 0) {
      forgetBadge(details.tabId);
      clearMenuCommands(details.tabId);
      void resetTabInjectedState(details.tabId, report).then(() =>
        requestBadgeRefresh(details.tabId),
      );
    } else {
      clearMenuCommands(details.tabId, details.frameId);
      void resetFrameInjectedState(details.tabId, details.frameId, report).then(() =>
        requestBadgeRefresh(details.tabId),
      );
    }
  });

  // The service worker can be restarted without an onInstalled event. Make
  // sure the redirect rule and registrations exist on every cold start.
  void bootstrapRuntime().catch((error) =>
    console.error('[Lumo Userscripts] Bootstrap failed:', error),
  );
});
