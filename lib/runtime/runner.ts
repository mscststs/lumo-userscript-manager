import type { RuntimeScriptPayload } from '@/types';
import { urlMatches } from '@/lib/script/url-rules';
import { createGmApi, type GmApiHandle, type GmTransport } from './gm-api';
import { HANDSHAKE, RUNNER_READY, type PageEvent, type PageRpcResponse } from './protocol';

declare global {
  // eslint-disable-next-line no-var
  var __LUMO_RUNNER__: { run: (payload: RuntimeScriptPayload) => void } | undefined;
  // eslint-disable-next-line no-var
  var __LUMO_RUNNER_QUEUE__: RuntimeScriptPayload[] | undefined;
}

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const gmApis = new Map<string, GmApiHandle>();
const storageNames = new Map<string, string>();
const noopTransport: GmTransport = {
  call: async () => {
    throw new Error('GM APIs are unavailable without a @grant.');
  },
  log: (level, args) => {
    const method = console[level] ?? console.log;
    method('[Lumo Userscripts]', ...args);
  },
  registerMenuCommand: async () => '',
  unregisterMenuCommand: async () => undefined,
};

let hostPort: MessagePort | null = null;
let hostReadyResolve: (() => void) | null = null;
let hostReady: Promise<void> | null = null;
const runnerToken = Math.random().toString(36).slice(2);

function ensureHost(): Promise<void> {
  if (hostPort) return Promise.resolve();
  if (!hostReady) {
    hostReady = new Promise((resolve, reject) => {
      hostReadyResolve = resolve;
      window.setTimeout(() => {
        if (!hostPort) {
          hostReady = null;
          hostReadyResolve = null;
          reject(new Error('Lumo host runtime did not become ready.'));
        }
      }, 10_000);
    });
  }
  return hostReady;
}

function rpc<T = unknown>(type: string, payload: Record<string, unknown>): Promise<T> {
  return ensureHost().then(
    () =>
      new Promise<T>((resolve, reject) => {
        const id = `${runnerToken}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        try {
          hostPort!.postMessage({ __lumo: 'rpc', id, type, payload });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
  );
}

function handleHostMessage(event: MessageEvent) {
  const data = event.data as PageRpcResponse | PageEvent;
  if (!data || typeof data !== 'object' || data.__lumo === undefined) return;

  if (data.__lumo === 'rpc-result') {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data.result);
    return;
  }

  if (data.__lumo === 'event') {
    const uuid = String(data.payload.uuid ?? '');
    const api = gmApis.get(uuid);
    if (!api) return;

    if (data.event === 'value-changed') {
      const storageName = String(data.payload.storageName ?? '');
      for (const [apiUuid, sibling] of gmApis) {
        if (apiUuid !== uuid && storageNames.get(apiUuid) === storageName) {
          sibling.emitValueChanged(
            String(data.payload.key ?? ''),
            data.payload.oldValue,
            data.payload.newValue,
            true,
          );
        }
      }
      if (String(data.payload.skipUuid ?? '') !== uuid) {
        api.emitValueChanged(
          String(data.payload.key ?? ''),
          data.payload.oldValue,
          data.payload.newValue,
          Boolean(data.payload.remote),
        );
      }
    } else if (data.event === 'menu-command') {
      (api.GM as any).__handleMenuCommand?.(String(data.payload.id ?? ''));
    } else if (data.event === 'notification-click') {
      api.emitNotificationClick(String(data.payload.id ?? ''), data.payload);
    } else if (data.event === 'notification-close') {
      api.emitNotificationClose(
        String(data.payload.id ?? ''),
        Boolean(data.payload.byUser),
      );
    } else if (data.event === 'xhr-progress') {
      api.emitXhrProgress(
        String(data.payload.requestId ?? ''),
        Number(data.payload.loaded ?? 0),
        Number(data.payload.total ?? 0),
      );
    } else if (data.event === 'download-progress') {
      api.emitDownloadProgress(
        String(data.payload.requestId ?? ''),
        Number(data.payload.loaded ?? 0),
        Number(data.payload.total ?? 0),
      );
    } else if (data.event === 'download-result') {
      api.emitDownloadResult(
        String(data.payload.requestId ?? ''),
        (data.payload.result as Record<string, unknown>) ?? {},
        data.payload.error ? String(data.payload.error) : undefined,
      );
    } else if (data.event === 'open-tab-closed') {
      api.emitOpenTabClosed(Number(data.payload.tabId ?? 0));
    }
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data as { __lumo?: string; nonce?: string };
  if (data?.__lumo !== HANDSHAKE || !event.ports[0]) return;
  hostPort?.close();
  hostPort = event.ports[0];
  hostPort.onmessage = handleHostMessage;
  hostPort.start();
  hostPort.postMessage({ __lumo: RUNNER_READY, nonce: data.nonce ?? '' });
  hostReadyResolve?.();
  hostReadyResolve = null;
});

function createTransport(uuid: string, token: string): GmTransport {
  return {
    call: (api, args) => rpc('gm', { api, args, uuid, token }),
    log: (level, args) => {
      const method = console[level] ?? console.log;
      method('[Lumo Userscripts]', ...args);
      if (hostPort) {
        try {
          hostPort.postMessage({
            __lumo: 'rpc',
            id: `${runnerToken}-log-${Date.now()}`,
            type: 'log',
            payload: { level, args, uuid, token },
          });
        } catch {
          hostPort = null;
        }
      }
    },
    registerMenuCommand: (title, options) =>
      rpc<string>('menu-register', { title, options, uuid, token }),
    unregisterMenuCommand: (id) =>
      rpc<void>('menu-unregister', { id, uuid, token }),
  };
}

async function run(payload: RuntimeScriptPayload) {
  if (!urlMatches(location.href, payload.rules)) return;
  if (payload.noFrames && window.top !== window) return;

  const scriptTransport = createTransport(payload.uuid, payload.token);

  try {
    const hasGrants = payload.grant.length > 0 && !payload.grant.includes('none');
    let values: Record<string, unknown> = {};
    let resources = {};

    if (hasGrants) {
      const bootstrap = await rpc<{
        storageName?: string;
        values: Record<string, unknown>;
        resources: Record<string, any>;
      }>('bootstrap', {
        uuid: payload.uuid,
        token: payload.token,
        href: location.href,
      });
      values = bootstrap.values ?? {};
      resources = bootstrap.resources ?? {};
      if (bootstrap.storageName) storageNames.set(payload.uuid, bootstrap.storageName);
    }

    const api = createGmApi({
      grant: payload.grant,
      meta: payload.meta,
      metaStr: payload.metaStr,
      handlerVersion: payload.handlerVersion,
      sandboxMode: 'raw',
      values,
      resources,
      transport: hasGrants ? scriptTransport : noopTransport,
      window,
      document,
      unsafeWindow: window,
    });
    gmApis.set(payload.uuid, api);

    await payload.run!.call(window, api.GM, api.GM_info, window);
    if (hostPort) {
      try {
        hostPort.postMessage({
          __lumo: 'rpc',
          id: `${runnerToken}-run-${Date.now()}`,
          type: 'run',
          payload: { uuid: payload.uuid, token: payload.token },
        });
      } catch {
        hostPort = null;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    console.error(`[Lumo Userscripts] ${payload.name}: ${message}`);
    scriptTransport.log('error', [`${payload.name}: ${message}`]);
    if (hostPort) {
      try {
        hostPort.postMessage({
          __lumo: 'rpc',
          id: `${runnerToken}-run-${Date.now()}`,
          type: 'run',
          payload: { uuid: payload.uuid, token: payload.token, error: message },
        });
      } catch {
        hostPort = null;
      }
    }
  }
}

globalThis.__LUMO_RUNNER__ = { run };
const queue = globalThis.__LUMO_RUNNER_QUEUE__;
if (queue) {
  globalThis.__LUMO_RUNNER_QUEUE__ = [];
  for (const payload of queue) void run(payload);
}
