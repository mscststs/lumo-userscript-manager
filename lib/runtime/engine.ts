import type { RuntimeScriptPayload } from '@/types';
import { urlMatches } from '@/lib/script/url-rules';
import { observePageLifecycle } from './lifecycle';
import { createGmApi, type GmApiHandle, type GmTransport } from './gm-api';
import {
  BridgeClient,
  BridgeError,
  type BridgeClientOptions,
} from './transport/bridge-client';
import type { BridgeEvent, RuntimeBootstrapResult } from './protocol';

export interface EngineOptions {
  /** Execution world owned by this engine bundle. */
  world: 'MAIN' | 'USER_SCRIPT';
  sandboxMode: 'raw' | 'content';
  /** Global key the launcher looks up (`__LUMO_RUNNER__` / `__LUMO_HOST__`). */
  engineKey: '__LUMO_RUNNER__' | '__LUMO_HOST__';
  /** Global key the launcher queues into before the engine is ready. */
  queueKey: '__LUMO_RUNNER_QUEUE__' | '__LUMO_HOST_QUEUE__';
  bridge?: Partial<Omit<BridgeClientOptions, 'kind' | 'onEvent' | 'onResume'>>;
}

const noopTransport: GmTransport = {
  call: async () => undefined,
  log: () => undefined,
  registerMenuCommand: async () => '',
  unregisterMenuCommand: async () => undefined,
};

/**
 * Shared engine implementation for both execution worlds.
 *
 * MAIN and USER_SCRIPT differ only in the sandbox flag and the globals the
 * launcher talks to; their transport, value cache, event fan-out and error
 * handling must stay identical. Keeping a single implementation here prevents
 * the two runtimes from drifting (the previous runner/host pair had already
 * accumulated a page-to-page bridge and two independent retry stacks).
 */
export function installEngine(options: EngineOptions): void {
  const globals = globalThis as Record<string, unknown>;
  // Defensive: a launcher can arrive while the engine module is still
  // evaluating (they are registered as separate entries). Re-executing the
  // engine must not replace the live client or duplicate listeners.
  if (globals[options.engineKey]) {
    // A launcher may have queued before a second engine injection; let the
    // already-installed engine drain it.
    const existing = globals[options.engineKey] as { run: (payload: RuntimeScriptPayload) => void };
    const pending = globals[options.queueKey] as RuntimeScriptPayload[] | undefined;
    if (pending) {
      globals[options.queueKey] = [];
      for (const payload of pending) void existing.run(payload);
    }
    return;
  }

  const apis = new Map<string, GmApiHandle>();
  const storageNames = new Map<string, string>();

  const client = new BridgeClient({
    kind: options.world === 'MAIN' ? 'main' : 'userscript',
    onEvent: handleEvent,
    onResume: () => {
      for (const api of apis.values()) api.resume();
    },
    ...options.bridge,
  });

  function handleEvent(message: BridgeEvent): void {
    const payload = message.payload;
    const uuid = String(payload.uuid ?? '');

    if (message.event === 'value-changed') {
      const originUuid = String(payload.originUuid ?? uuid);
      const storageName = String(payload.storageName ?? '');
      for (const [apiUuid, api] of apis) {
        // The origin already emitted its own listener synchronously with
        // `remote=false` when it called GM_setValue.
        if (apiUuid === originUuid) continue;
        if ((storageNames.get(apiUuid) ?? apiUuid) !== storageName) continue;
        api.emitValueChanged(
          String(payload.key ?? ''),
          payload.oldValue,
          payload.newValue,
          true,
        );
      }
      return;
    }

    const api = apis.get(uuid);
    if (!api) return;

    switch (message.event) {
      case 'menu-command':
        api.handleMenuCommand(String(payload.id ?? ''));
        break;
      case 'notification-click':
        api.emitNotificationClick(String(payload.id ?? ''), payload);
        break;
      case 'notification-close':
        api.emitNotificationClose(String(payload.id ?? ''), Boolean(payload.byUser));
        break;
      case 'xhr-progress':
        api.emitXhrProgress(
          String(payload.requestId ?? ''),
          Number(payload.loaded ?? 0),
          Number(payload.total ?? 0),
        );
        break;
      case 'download-progress':
        api.emitDownloadProgress(
          String(payload.requestId ?? ''),
          Number(payload.loaded ?? 0),
          Number(payload.total ?? 0),
        );
        break;
      case 'download-result':
        api.emitDownloadResult(
          String(payload.requestId ?? ''),
          (payload.result as Record<string, unknown>) ?? {},
          payload.error ? String(payload.error) : undefined,
        );
        break;
      case 'open-tab-closed':
        api.emitOpenTabClosed(Number(payload.tabId ?? 0));
        break;
      default:
        break;
    }
  }

  function createTransport(payload: RuntimeScriptPayload): GmTransport {
    const uuid = payload.uuid;
    const token = payload.runtimeToken;

    return {
      call: (api, args) => {
        if (api === 'GM_setClipboard') {
          return copyToClipboard(String(args[0] ?? ''), String(args[1] ?? 'text'));
        }
        if (api === 'GM_setValue') {
          return client.call('host:value:set', { uuid, token, key: args[0], value: args[1] });
        }
        if (api === 'GM_deleteValue') {
          return client.call('host:value:delete', { uuid, token, key: args[0] });
        }
        return client.call('host:gm', { uuid, token, api, args });
      },
      log: (level, args) => {
        const method = console[level] ?? console.log;
        method('[Lumo Userscripts]', ...args);
        void client
          .call('host:log', { uuid, token, level, args })
          .catch(() => undefined);
      },
      registerMenuCommand: (id, title, menuOptions) =>
        client.call<string>('host:menu:register', {
          uuid,
          token,
          id,
          title,
          options: menuOptions,
        }),
      unregisterMenuCommand: (id) =>
        client.call('host:menu:unregister', { uuid, token, id }),
    };
  }

  async function bootstrap(payload: RuntimeScriptPayload): Promise<RuntimeBootstrapResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await client.call<RuntimeBootstrapResult>(
          'host:bootstrap',
          { uuid: payload.uuid, token: payload.runtimeToken, href: location.href },
          { timeoutMs: 15_000 },
        );
      } catch (error) {
        lastError = error;
        const code = error instanceof BridgeError ? error.code : '';
        if (code !== 'BACKGROUND_UNAVAILABLE') break;
        await delay(250 * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function run(payload: RuntimeScriptPayload): Promise<void> {
    if (!urlMatches(location.href, payload.rules)) return;
    if (payload.noFrames && window.top !== window) return;

    const previous = apis.get(payload.uuid);
    if (previous) {
      previous.dispose();
      apis.delete(payload.uuid);
      storageNames.delete(payload.uuid);
    }

    const hasGrants = payload.grant.length > 0 && !payload.grant.includes('none');

    try {
      let values: Record<string, unknown> = {};
      let resources: RuntimeBootstrapResult['resources'] = {};

      if (hasGrants) {
        const result = await bootstrap(payload);
        values = result.values ?? {};
        resources = result.resources ?? {};
        if (result.storageName) storageNames.set(payload.uuid, result.storageName);
      }

      const api = createGmApi({
        uuid: payload.uuid,
        grant: payload.grant,
        meta: payload.meta,
        metaStr: payload.metaStr,
        handlerVersion: payload.handlerVersion,
        sandboxMode: options.sandboxMode,
        values,
        resources,
        transport: hasGrants ? createTransport(payload) : noopTransport,
        window,
        document,
        unsafeWindow: window,
      });
      apis.set(payload.uuid, api);

      // Report the start *before* the body runs. The badge and the menu list
      // must not wait for a script that awaits a network round trip (or never
      // settles), and one report per frame is what makes a frame-only script
      // visible at all. Errors are reported separately below, so this call is
      // never repeated for the same document unless the script really restarts.
      void client
        .call('host:run', { uuid: payload.uuid, token: payload.runtimeToken })
        .catch(() => undefined);

      await payload.run!.call(window, api.GM, api.GM_info, window);
    } catch (error) {
      const message =
        error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
      console.error(`[Lumo Userscripts] ${payload.name}: ${message}`);

      const code = error instanceof BridgeError ? error.code : '';
      if (code === 'BRIDGE_UNAVAILABLE') {
        // The bridge itself never appeared (for example, the extension was
        // reloaded while this tab stayed open). Do not pile more failed RPCs
        // on top of the transport error.
        return;
      }
      void client
        .call('host:log', {
          uuid: payload.uuid,
          token: payload.runtimeToken,
          level: 'error',
          args: [`${payload.name}: ${message}`],
        })
        .catch(() => undefined);
      void client
        .call('host:run', {
          uuid: payload.uuid,
          token: payload.runtimeToken,
          error: message,
        })
        .catch(() => undefined);
    }
  }

  globals[options.engineKey] = { run };

  const queued = globals[options.queueKey] as RuntimeScriptPayload[] | undefined;
  if (queued) {
    globals[options.queueKey] = [];
    for (const payload of queued) void run(payload);
  }

  if (typeof window !== 'undefined') {
    // Only a real unload tears the engine down. A document that enters the
    // back/forward cache keeps running (the browser freezes it), and it is
    // never re-injected on restore, so disposing its GM APIs here would leave a
    // live script talking to a dead transport. The replay after a resume is
    // driven by `BridgeClient.onResume`, which covers both a worker restart and
    // a lost engine channel.
    observePageLifecycle({
      onTerminate: () => {
        for (const api of apis.values()) api.dispose();
        apis.clear();
        client.dispose();
      },
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyToClipboard(text: string, type = 'text'): Promise<void> {
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
