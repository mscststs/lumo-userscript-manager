import type { ScriptMetadata } from '@/types';
import {
  getDraft,
  listLogs,
  clearLogs,
  clearStore,
  replaceResources,
  cleanupDrafts,
} from '@/lib/db';
import { storage } from '@/store/storage';
import { getValuesForScript, setValueForScript, deleteValueForScript } from '@/lib/background/values';
import { listMenuCommands, clearMenuCommands } from '@/lib/background/menus';
import {
  registerHostPort,
  sendToHost,
  clearHostPortsForTab,
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
import {
  broadcast,
  commitInstall,
  destroyScript,
  getAllScripts,
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
      return getAllScripts(Boolean(payload.includeRemoved));
    case 'scripts:getDetail':
      return getScriptDetail(String(payload.uuid ?? ''));
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
    case 'menus:invoke':
      return sendToHost(Number(payload.tabId ?? -1), Number(payload.frameId ?? 0), {
        type: 'bg:event',
        event: 'menu-command',
        payload: { uuid: payload.uuid, id: payload.id },
      });
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
      return true;
    case 'backup:export':
      return exportBackup();
    case 'backup:import':
      return importBackup(payload);
    case 'storage:clear':
      await clearStore('logs');
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

async function importBackup(payload: Record<string, any>): Promise<{ imported: number; errors: string[] }> {
  const data = payload.data;
  if (!data || data.format !== 'lumo-userscripts' || !Array.isArray(data.scripts)) {
    throw new Error('Invalid backup file.');
  }
  if (data.settings && typeof data.settings === 'object') {
    try {
      await storage.importConfig({ uiSettings: data.settings });
    } catch {
      // A malformed settings block must not abort the script import.
    }
  }
  let imported = 0;
  const errors: string[] = [];
  for (const entry of data.scripts) {
    try {
      if (entry?.script && entry?.code) {
        const record = await saveScriptFromCode(
          entry.script.uuid ?? null,
          String(entry.code),
          entry.script.origin ?? '',
        );
        if (entry.script.selfMetadata) {
          await updateSelfMetadata(record.uuid, entry.script.selfMetadata);
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
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  await requestRegistration();
  broadcast('scripts-changed');
  return { imported, errors };
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
  });

  chrome.webNavigation?.onCommitted?.addListener((details) => {
    if (details.frameId === 0) clearMenuCommands(details.tabId);
    else clearMenuCommands(details.tabId, details.frameId);
  });

  // The service worker can be restarted without an onInstalled event. Make
  // sure the redirect rule and registrations exist on every cold start.
  void bootstrapRuntime().catch((error) =>
    console.error('[Lumo Userscripts] Bootstrap failed:', error),
  );
});
