import type { LogEntry, RuntimeMenuCommand, ScriptMetadata } from '@/types';
import {
  getDraft,
  getResources,
  getScript,
  getValues,
  listLogs,
  clearLogs,
  clearStore,
  replaceResources,
  cleanupDrafts,
} from '@/lib/db';
import { getStorageName } from '@/lib/script/storage-name';
import { mergeMetadata } from '@/lib/script/metadata';
import { compileUrlRules, urlMatches } from '@/lib/script/url-rules';
import { storage } from '@/store/storage';
import { resourcesForRuntime } from '@/lib/background/resources';
import { getValuesForScript, setValueForScript, deleteValueForScript } from '@/lib/background/values';
import { recordLog } from '@/lib/background/logs';
import { registerMenuCommand, unregisterMenuCommand, listMenuCommands, clearMenuCommands } from '@/lib/background/menus';
import {
  registerHostPort,
  sendToHost,
  clearHostPortsForTab,
} from '@/lib/background/host-ports';
import {
  handleGmApi,
  onDownloadChanged,
  onNotificationButtonClicked,
  onNotificationClicked,
  onNotificationClosed,
  onTabRemoved,
} from '@/lib/background/gm';
import {
  broadcast,
  commitInstall,
  destroyScript,
  getAllScripts,
  getPopupData,
  getScriptDetail,
  prepareInstall,
  markScriptRun,
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
  runScriptOnTab,
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

function sendBgResult(port: chrome.runtime.Port, id: string, result?: unknown, error?: string) {
  try {
    port.postMessage({ type: 'bg:result', id, result, error });
  } catch {
    // The host frame navigated away while the request was in flight.
  }
}

function hostContext(
  sender: chrome.runtime.MessageSender | undefined,
  payload: Record<string, unknown>,
) {
  return {
    tabId: sender?.tab?.id ?? -1,
    frameId: sender?.frameId ?? 0,
    url: sender?.url ?? sender?.tab?.url ?? '',
    uuid: String(payload.uuid ?? ''),
  };
}

async function handleHostRequest(
  type: string,
  payload: Record<string, unknown>,
  ctx: ReturnType<typeof hostContext>,
): Promise<unknown> {
  {
      switch (type) {
        case 'host:ready':
          return;
        case 'host:ping':
          return { time: Date.now() };
        case 'host:bootstrap': {
          const script = await getScript(ctx.uuid);
          if (!script || !script.enabled || script.removedAt) {
            throw new Error('Script is not active.');
          }
          const effective = mergeMetadata(script.metadata, script.selfMetadata);
          if (ctx.url && !urlMatches(ctx.url, compileUrlRules(effective))) {
            throw new Error('Script does not match this page.');
          }
          const { values, storageName } = await getValuesForScript(ctx.uuid);
          const resources = resourcesForRuntime(await getResources(ctx.uuid), effective);
          return { storageName, values, resources };
        }
        case 'host:gm':
          return handleGmApi(String(payload.api ?? ''), (payload.args as unknown[]) ?? [], ctx);
        case 'host:value:set':
          await setValueForScript(ctx.uuid, String(payload.key ?? ''), payload.value, {
            tabId: ctx.tabId,
            frameId: ctx.frameId,
          });
          return undefined;
        case 'host:value:delete':
          await deleteValueForScript(ctx.uuid, String(payload.key ?? ''), {
            tabId: ctx.tabId,
            frameId: ctx.frameId,
          });
          return undefined;
        case 'host:run':
          await markScriptRun(
            ctx.uuid,
            payload.error ? String(payload.error) : undefined,
          );
          return undefined;
        case 'host:log':
          await recordLog(
            (String(payload.level ?? 'info') as LogEntry['level']) ?? 'info',
            (payload.args as unknown[]) ?? [],
            ctx.uuid,
            ctx.url,
          );
          return undefined;
        case 'host:menu:register': {
          const id = `${ctx.uuid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          const command: RuntimeMenuCommand = {
            id,
            uuid: ctx.uuid,
            title: String(payload.title ?? ''),
            accessKey:
              typeof payload.options === 'object' && payload.options
                ? (payload.options as Record<string, unknown>).accessKey as string | undefined
                : undefined,
            tabId: ctx.tabId,
            frameId: ctx.frameId,
          };
          registerMenuCommand(command);
          broadcast('menus-changed', { tabId: ctx.tabId });
          return id;
        }
        case 'host:menu:unregister': {
          unregisterMenuCommand(ctx.tabId, ctx.frameId, ctx.uuid, String(payload.id ?? ''));
          broadcast('menus-changed', { tabId: ctx.tabId });
          return undefined;
        }
        default:
          throw new Error(`Unknown host message: ${type}`);
      }
  }
}

function handleHostPort(port: chrome.runtime.Port, sender: chrome.runtime.MessageSender) {
  const record = registerHostPort(port, sender);
  if (!record) return;

  port.onMessage.addListener((message: any) => {
    const type = String(message?.type ?? '');
    const id = String(message?.id ?? '');
    const payload = (message?.payload ?? {}) as Record<string, unknown>;
    const ctx = {
      tabId: record.tabId,
      frameId: record.frameId,
      url: record.url,
      uuid: String(payload.uuid ?? ''),
    };
    void handleHostRequest(type, payload, ctx).then(
      (result) => sendBgResult(port, id, result),
      (error) => sendBgResult(port, id, undefined, error instanceof Error ? error.message : String(error)),
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
    return handleHostRequest(type, payload, hostContext(sender, payload));
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
    case 'scripts:run': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('No active tab.');
      await runScriptOnTab(String(payload.uuid ?? ''), tab.id);
      return true;
    }
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
    if (port.name === 'lumo:host') {
      handleHostPort(port, port.sender ?? {});
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handleRuntimeMessage(message, sender).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
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
