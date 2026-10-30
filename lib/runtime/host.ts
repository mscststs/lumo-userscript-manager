import type { RuntimeScriptPayload } from '@/types';
import { urlMatches } from '@/lib/script/url-rules';
import { createGmApi, type GmApiHandle, type GmTransport } from './gm-api';
import { HANDSHAKE, RUNNER_READY, type PageMessage } from './protocol';
import {
  BRIDGE_EVENT,
  BRIDGE_HELLO,
  BRIDGE_READY,
  BRIDGE_RESULT,
  BRIDGE_RPC,
  type BridgeEvent,
  type BridgeResult,
  type BridgeRpc,
} from './bridge-protocol';

declare global {
  // eslint-disable-next-line no-var
  var __LUMO_HOST__: { run: (payload: RuntimeScriptPayload) => void } | undefined;
  // eslint-disable-next-line no-var
  var __LUMO_HOST_QUEUE__: RuntimeScriptPayload[] | undefined;
}

type BgMessage =
  | { type: 'bg:result'; id: string; result?: unknown; error?: string }
  | { type: 'bg:event'; event: string; payload: Record<string, unknown> };

const bridgePending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const pending = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    request: { type: string; payload: Record<string, unknown> };
    retry: boolean;
    timer?: number;
  }
>();
const contentApis = new Map<string, GmApiHandle>();
const allowedTokens = new Map<string, string>();
const storageNames = new Map<string, string>();
const bootstrapCache = new Map<string, { values: Record<string, unknown>; resources: Record<string, any> }>();
const requestId = Math.random().toString(36).slice(2);

let bgPort: chrome.runtime.Port | null = null;
let bgQueue: {
  type: string;
  payload: Record<string, unknown>;
  retry: boolean;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}[] = [];
let bgConnecting = false;
let bgPingTimer: number | null = null;
let runnerPort: MessagePort | null = null;
let runnerNonce = '';
let bridgeTimer: number | null = null;
let bridgeAttempts = 0;
let contentBridgePort: MessagePort | null = null;
let contentBridgeNonce = '';
let contentBridgeReady = false;
let contentBridgeFailedAt = 0;
let contentBridgeWaiters: ((ready: boolean) => void)[] = [];

function startContentBridge() {
  if (contentBridgePort || bridgeTimer !== null) return;
  const nonce = `bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  contentBridgeNonce = nonce;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    const data = event.data as BridgeResult | BridgeEvent;
    if (data?.__lumoBridge === BRIDGE_RESULT) {
      const entry = bridgePending.get(data.id);
      if (!entry) return;
      bridgePending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data.result);
    } else if (data?.__lumoBridge === BRIDGE_EVENT) {
      handleBackgroundEvent(data.event, data.payload);
    }
  };
  channel.port1.start();
  contentBridgePort = channel.port1;
  window.postMessage({ __lumoBridge: BRIDGE_HELLO, nonce }, '*', [channel.port2]);
  bridgeTimer = window.setTimeout(() => {
    bridgeTimer = null;
    if (!contentBridgeReady) {
      contentBridgePort?.close();
      contentBridgePort = null;
      startContentBridge();
    }
  }, 250);
}

function ensureContentBridge(timeoutMs = 1_500): Promise<boolean> {
  if (contentBridgeReady && contentBridgePort) return Promise.resolve(true);
  if (!contentBridgePort) startContentBridge();
  if (contentBridgeReady && contentBridgePort) return Promise.resolve(true);
  if (Date.now() - contentBridgeFailedAt < 1_000) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      contentBridgeWaiters = contentBridgeWaiters.filter((item) => item !== finish);
      if (!ready) contentBridgeFailedAt = Date.now();
      resolve(ready);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    contentBridgeWaiters.push(finish);
  });
}

function contentBridgeRequest<T>(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs = 0,
): Promise<T> {
  if (!contentBridgePort || !contentBridgeReady) {
    return Promise.reject(new Error('Content bridge is not ready.'));
  }
  return new Promise<T>((resolve, reject) => {
    const id = `${requestId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer =
      timeoutMs > 0
        ? window.setTimeout(() => {
            bridgePending.delete(id);
            reject(new Error('Content bridge request timed out.'));
          }, timeoutMs)
        : null;
    bridgePending.set(id, {
      resolve: (value) => {
        if (timer !== null) window.clearTimeout(timer);
        resolve(value as T);
      },
      reject: (error) => {
        if (timer !== null) window.clearTimeout(timer);
        reject(error);
      },
    });
    const message: BridgeRpc = { __lumoBridge: BRIDGE_RPC, id, type, payload };
    contentBridgePort!.postMessage(message);
  });
}

async function connectBackground() {
  if (bgPort || bgConnecting) return;
  bgConnecting = true;
  try {
    // A port connection alone does not always wake a sleeping MV3 worker.
    // Send a one-shot runtime message first so `onConnect` is guaranteed to be
    // registered before the long-lived port is created.
    try {
      await chrome.runtime.sendMessage({ type: 'host:wake', payload: { url: location.href } });
    } catch {
      // The port attempt below will surface the real error if the worker is
      // still unavailable.
    }
    const port = chrome.runtime.connect({ name: 'lumo:host' });
    bgPort = port;
    port.onMessage.addListener((message: BgMessage) => {
      if (message.type === 'bg:result') {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error));
        else entry.resolve(message.result);
        return;
      }
      if (message.type === 'bg:event') handleBackgroundEvent(message.event, message.payload);
    });
    if (bgPingTimer !== null) window.clearInterval(bgPingTimer);
    // MV3 service workers are evicted after an idle period. A cheap ping keeps
    // the port (and the SW) alive while a slow document is still loading and
    // before the script's document-body/document-idle bootstrap runs.
    bgPingTimer = window.setInterval(() => {
      try {
        port.postMessage({ type: 'host:ping', payload: {} });
      } catch {
        // onDisconnect will handle reconnection.
      }
    }, 20_000);
    port.onDisconnect.addListener(() => {
      // The event port is best-effort; requests use chrome.runtime.sendMessage.
      // Do not spam the page console when Chromium has evicted the worker.
      bgPort = null;
      if (bgPingTimer !== null) {
        window.clearInterval(bgPingTimer);
        bgPingTimer = null;
      }
      const retryItems: typeof bgQueue = [];
      for (const entry of pending.values()) {
        if (entry.retry) {
          retryItems.push({
            type: entry.request.type,
            payload: entry.request.payload,
            retry: true,
            resolve: entry.resolve,
            reject: entry.reject,
          });
        } else {
          entry.reject(new Error('Background connection closed.'));
        }
      }
      pending.clear();
      bgQueue.push(...retryItems);
      window.setTimeout(() => void connectBackground(), 500);
    });
    port.postMessage({ type: 'host:ready', payload: { url: location.href } });
    const queue = bgQueue;
    bgQueue = [];
    for (const item of queue) {
      void bgRequest(item.type, item.payload, { retry: item.retry }).then(item.resolve, item.reject);
    }
  } catch {
    bgPort = null;
    window.setTimeout(() => void connectBackground(), 1_000);
  } finally {
    bgConnecting = false;
  }
}

async function bgRequest<T = unknown>(
  type: string,
  payload: Record<string, unknown>,
  options: { retry?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  // Prefer the normal content-script bridge. It owns chrome.runtime, which is
  // reliable in ISOLATED content scripts, and keeps USER_SCRIPT execution
  // decoupled from MV3 service-worker messaging. Fall back to direct runtime
  // messaging only if the bridge is unavailable.
  if (await ensureContentBridge()) {
    return contentBridgeRequest<T>(type, payload, options.timeoutMs ?? 0);
  }
  return messageRequest<T>(type, payload, options.timeoutMs ?? 0);
}

function postToRunner(message: PageMessage) {
  if (!runnerPort) return;
  try {
    runnerPort.postMessage(message);
  } catch {
    runnerPort = null;
  }
}

function handleBackgroundEvent(event: string, payload: Record<string, unknown>) {
  const uuid = String(payload.uuid ?? '');
  if (event === 'value-changed') {
    const storageName = String(payload.storageName ?? '');
    for (const [apiUuid, api] of contentApis) {
      if (apiUuid !== uuid && storageNames.get(apiUuid) === storageName) {
        api.emitValueChanged(
          String(payload.key ?? ''),
          payload.oldValue,
          payload.newValue,
          true,
        );
      }
    }
    const api = contentApis.get(uuid);
    if (api) {
      api.emitValueChanged(
        String(payload.key ?? ''),
        payload.oldValue,
        payload.newValue,
        Boolean(payload.remote),
      );
    }
    postToRunner({
      __lumo: 'event',
      event: 'value-changed',
      payload,
    });
  } else if (event === 'menu-command') {
    const api = contentApis.get(uuid);
    if (api) {
      (api.GM as any).__handleMenuCommand?.(String(payload.id ?? ''));
    } else {
      postToRunner({ __lumo: 'event', event: 'menu-command', payload });
    }
  } else if (event === 'notification-click') {
    const api = contentApis.get(uuid);
    if (api) api.emitNotificationClick(String(payload.id ?? ''), payload);
    postToRunner({ __lumo: 'event', event: 'notification-click', payload });
  } else if (event === 'notification-close') {
    const api = contentApis.get(uuid);
    if (api) api.emitNotificationClose(String(payload.id ?? ''), Boolean(payload.byUser));
    postToRunner({ __lumo: 'event', event: 'notification-close', payload });
  } else if (event === 'xhr-progress') {
    const api = contentApis.get(uuid);
    if (api) {
      api.emitXhrProgress(
        String(payload.requestId ?? ''),
        Number(payload.loaded ?? 0),
        Number(payload.total ?? 0),
      );
    }
    postToRunner({ __lumo: 'event', event: 'xhr-progress', payload });
  } else if (event === 'download-progress') {
    const api = contentApis.get(uuid);
    if (api) {
      api.emitDownloadProgress(
        String(payload.requestId ?? ''),
        Number(payload.loaded ?? 0),
        Number(payload.total ?? 0),
      );
    }
    postToRunner({ __lumo: 'event', event: 'download-progress', payload });
  } else if (event === 'download-result') {
    const api = contentApis.get(uuid);
    if (api) {
      api.emitDownloadResult(
        String(payload.requestId ?? ''),
        (payload.result as Record<string, unknown>) ?? {},
        payload.error ? String(payload.error) : undefined,
      );
    }
    postToRunner({ __lumo: 'event', event: 'download-result', payload });
  } else if (event === 'open-tab-closed') {
    const api = contentApis.get(uuid);
    if (api) api.emitOpenTabClosed(Number(payload.tabId ?? 0));
    postToRunner({ __lumo: 'event', event: 'open-tab-closed', payload });
  }
}

function broadcastLocalValueChange(
  originUuid: string,
  key: string,
  oldValue: unknown,
  newValue: unknown,
) {
  const storageName = storageNames.get(originUuid) ?? originUuid;
  for (const [apiUuid, api] of contentApis) {
    if (apiUuid !== originUuid && (storageNames.get(apiUuid) ?? apiUuid) === storageName) {
      api.emitValueChanged(key, oldValue, newValue, true);
    }
  }
  postToRunner({
    __lumo: 'event',
    event: 'value-changed',
    payload: {
      uuid: originUuid,
      skipUuid: originUuid,
      storageName,
      key,
      oldValue,
      newValue,
      remote: true,
    },
  });
}

async function handleGm(api: string, args: unknown[], uuid: string): Promise<unknown> {
  if (api === 'GM_setValue') {
    const [key, value] = args as [string, unknown];
    const cache = bootstrapCache.get(uuid);
    const oldValue = cache?.values[key];
    if (cache) {
      if (value === undefined) delete cache.values[key];
      else cache.values[key] = value;
    }
    await bgRequest('host:value:set', { uuid, key, value });
    broadcastLocalValueChange(uuid, key, oldValue, value);
    return undefined;
  }
  if (api === 'GM_deleteValue') {
    const [key] = args as [string];
    const cache = bootstrapCache.get(uuid);
    const oldValue = cache?.values[key];
    if (cache) delete cache.values[key];
    await bgRequest('host:value:delete', { uuid, key });
    broadcastLocalValueChange(uuid, key, oldValue, undefined);
    return undefined;
  }
  if (api === 'GM_setClipboard') {
    const [data, type] = args as [string, string];
    await copyToClipboard(String(data), String(type ?? 'text'));
    return undefined;
  }
  return bgRequest('host:gm', { uuid, api, args });
}

async function copyToClipboard(text: string, type = 'text/plain') {
  const mime = type === 'text' ? 'text/plain' : type === 'html' ? 'text/html' : type;
  if (mime !== 'text/plain' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ [mime]: new Blob([text], { type: mime }) }),
      ]);
      return;
    } catch {
      // Fall through to the text fallback.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    (document.body ?? document.documentElement).appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  if (mime !== 'text/plain') {
    console.warn(`[Lumo Userscripts] Clipboard type ${mime} is not supported; copied as text.`);
  }
}

const noopTransport: GmTransport = {
  call: async () => undefined,
  log: () => undefined,
  registerMenuCommand: async () => '',
  unregisterMenuCommand: async () => undefined,
};

function createContentTransport(uuid: string): GmTransport {
  const token = () => allowedTokens.get(uuid) ?? '';
  return {
    call: (api, args) => handleGm(api, args, uuid),
    log: (level, args) => {
      const method = console[level] ?? console.log;
      method('[Lumo Userscripts]', ...args);
      void bgRequest('host:log', { level, args, uuid }).catch(() => undefined);
    },
    registerMenuCommand: (title, options) =>
      bgRequest<string>('host:menu:register', { uuid, token: token(), title, options }),
    unregisterMenuCommand: (id) =>
      bgRequest('host:menu:unregister', { uuid, token: token(), id }),
  };
}

function messageRequest<T>(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer =
      timeoutMs > 0
        ? window.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('Background message timed out.'));
          }, timeoutMs)
        : null;
    const finish = (error: Error | null, result?: T) => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (error) reject(error);
      else resolve(result as T);
    };
    try {
      chrome.runtime.sendMessage({ type, payload }, (response: any) => {
        const lastError = chrome.runtime.lastError?.message;
        if (lastError) {
          finish(new Error(lastError));
        } else if (!response?.ok) {
          finish(new Error(String(response?.error ?? 'Background message failed.')));
        } else {
          finish(null, response.result as T);
          // A successful message means the worker is awake; now it is safe to
          // open the long-lived port used for pushed events.
          void connectBackground();
        }
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function bootstrapRequest(
  uuid: string,
  token: string,
  href: string,
): Promise<{
  storageName?: string;
  values: Record<string, unknown>;
  resources: Record<string, any>;
}> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await bgRequest(
        'host:bootstrap',
        { uuid, token, href },
        { retry: true, timeoutMs: 10_000 },
      );
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        try {
          return await messageRequest('host:bootstrap', { uuid, token, href }, 10_000);
        } catch (messageError) {
          lastError = messageError;
        }
      }
      if (attempt < 4) {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
    }
  }
  try {
    return await messageRequest(
      'host:bootstrap',
      { uuid, token, href },
      10_000,
    );
  } catch (error) {
    throw error ?? lastError ?? new Error('Background bootstrap failed.');
  }
}

async function handleRunnerRpc(message: PageMessage, port: MessagePort) {
  if (message.__lumo !== 'rpc') return;
  const payload = message.payload;
  const uuid = String(payload.uuid ?? '');
  const token = String(payload.token ?? '');

  try {
    if (message.type === 'bootstrap') {
      const href = String(payload.href ?? location.href);
      const result = await bootstrapRequest(uuid, token, href);
      allowedTokens.set(uuid, token);
      bootstrapCache.set(uuid, result);
      if (result.storageName) storageNames.set(uuid, result.storageName);
      port.postMessage({ __lumo: 'rpc-result', id: message.id, result });
      return;
    }

    if (allowedTokens.get(uuid) !== token) {
      throw new Error('Invalid script token.');
    }

    if (message.type === 'gm') {
      const result = await handleGm(String(payload.api ?? ''), (payload.args as unknown[]) ?? [], uuid);
      port.postMessage({ __lumo: 'rpc-result', id: message.id, result });
      return;
    }

    if (message.type === 'menu-register') {
      const result = await bgRequest<string>('host:menu:register', {
        uuid,
        token,
        title: payload.title,
        options: payload.options,
      });
      port.postMessage({ __lumo: 'rpc-result', id: message.id, result });
      return;
    }

    if (message.type === 'menu-unregister') {
      await bgRequest('host:menu:unregister', { uuid, token, id: payload.id });
      port.postMessage({ __lumo: 'rpc-result', id: message.id, result: undefined });
      return;
    }

    if (message.type === 'log') {
      const method = console[(String(payload.level ?? 'info') as 'info')] ?? console.log;
      method('[Lumo Userscripts]', ...((payload.args as unknown[]) ?? []));
      await bgRequest('host:log', {
        level: payload.level,
        args: payload.args,
        uuid,
      });
      return;
    }

    if (message.type === 'run') {
      await bgRequest('host:run', {
        uuid,
        error: payload.error ? String(payload.error) : undefined,
      });
      return;
    }

    throw new Error(`Unknown host request: ${message.type}`);
  } catch (error) {
    port.postMessage({
      __lumo: 'rpc-result',
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function startPageBridge() {
  if (runnerPort || bridgeAttempts > 40) return;
  bridgeAttempts += 1;
  const nonce = `n-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  runnerNonce = nonce;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    const message = event.data as any;
    if (message?.__lumo === RUNNER_READY) {
      if (message.nonce !== runnerNonce) return;
      runnerPort = channel.port1;
      channel.port1.start();
      if (bridgeTimer !== null) {
        window.clearTimeout(bridgeTimer);
        bridgeTimer = null;
      }
      return;
    }
    void handleRunnerRpc(message, channel.port1);
  };
  channel.port1.start();
  window.postMessage({ __lumo: HANDSHAKE, nonce }, '*', [channel.port2]);
  bridgeTimer = window.setTimeout(startPageBridge, 250);
}

async function run(payload: RuntimeScriptPayload) {
  if (!urlMatches(location.href, payload.rules)) return;
  if (payload.noFrames && window.top !== window) return;

  allowedTokens.set(payload.uuid, payload.token);

  try {
    const hasGrants = payload.grant.length > 0 && !payload.grant.includes('none');
    let values: Record<string, unknown> = {};
    let resources = {};
    if (hasGrants) {
      const bootstrap = await bootstrapRequest(payload.uuid, payload.token, location.href);
      values = bootstrap.values ?? {};
      resources = bootstrap.resources ?? {};
      bootstrapCache.set(payload.uuid, { values, resources });
      if (bootstrap.storageName) storageNames.set(payload.uuid, bootstrap.storageName);
    }

    const api = createGmApi({
      grant: payload.grant,
      meta: payload.meta,
      metaStr: payload.metaStr,
      handlerVersion: payload.handlerVersion,
      sandboxMode: 'content',
      values,
      resources,
      transport: hasGrants ? createContentTransport(payload.uuid) : noopTransport,
      window,
      document,
      unsafeWindow: window,
    });
    contentApis.set(payload.uuid, api);

    await payload.run!.call(window, api.GM, api.GM_info, window);
    void bgRequest('host:run', { uuid: payload.uuid }).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    console.error(`[Lumo Userscripts] ${payload.name}: ${message}`);
    void bgRequest('host:log', {
      level: 'error',
      args: [`${payload.name}: ${message}`],
      uuid: payload.uuid,
    }).catch(() => undefined);
    void bgRequest('host:run', { uuid: payload.uuid, error: message }).catch(() => undefined);
  }
}

globalThis.__LUMO_HOST__ = { run };
startContentBridge();
startPageBridge();

const queue = globalThis.__LUMO_HOST_QUEUE__;
if (queue) {
  globalThis.__LUMO_HOST_QUEUE__ = [];
  for (const payload of queue) void run(payload);
}
