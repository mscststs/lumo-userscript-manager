import {
  BRIDGE_EVENT,
  BRIDGE_READY,
  BRIDGE_RESULT,
  BRIDGE_RESUME,
  BRIDGE_RPC,
  HOST_RPC_TYPES,
  isBridgeHello,
  isBridgeRpc,
  type BridgeEvent,
  type BridgeResult,
  type BridgeRpc,
  type HostResponse,
} from '../protocol';
import { observePageLifecycle } from '../lifecycle';

const MAX_CLIENTS = 8;
const BACKGROUND_PORT_NAME = 'lumo:bridge';
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 30_000;

interface ClientRecord {
  id: string;
  port: MessagePort;
  kind: string;
}

/**
 * The only runtime component that talks to the extension background from a
 * page. It runs as a normal ISOLATED content script, so `chrome.runtime`
 * behaves like any other content script and does not depend on the
 * `userScripts` world's messaging support (which is unavailable in some
 * Chromium builds, Chrome 156 included).
 *
 * Responsibilities are deliberately narrow:
 *   - accept one or more engine channels (MAIN / USER_SCRIPT)
 *   - forward allow-listed RPCs to the worker with one-shot messages
 *   - own the single long-lived port used for pushed events
 *   - reconnect that port and tell engines to replay subscriptions
 */
export function startContentBridge(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
  const hostWindow = window as unknown as { __LUMO_BRIDGE_STARTED__?: boolean };
  if (hostWindow.__LUMO_BRIDGE_STARTED__) return;
  hostWindow.__LUMO_BRIDGE_STARTED__ = true;

  const clients = new Map<string, ClientRecord>();
  const bridgeId = createId();
  let bgPort: chrome.runtime.Port | null = null;
  let bgConnecting = false;
  let bgEverConnected = false;
  let retryDelay = RETRY_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let unbindLifecycle: (() => void) | null = null;

  const postToClient = (record: ClientRecord, message: BridgeResult | BridgeEvent) => {
    try {
      record.port.postMessage(message);
    } catch {
      clients.delete(record.id);
    }
  };

  const broadcast = (message: BridgeEvent) => {
    for (const record of [...clients.values()]) {
      try {
        record.port.postMessage(message);
      } catch {
        clients.delete(record.id);
      }
    }
  };

  const notifyResume = () => {
    for (const record of [...clients.values()]) {
      try {
        record.port.postMessage({ __lumo: BRIDGE_RESUME });
      } catch {
        clients.delete(record.id);
      }
    }
  };

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (disposed || retryTimer !== null) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connectBackground();
    }, delay + Math.floor(Math.random() * 200));
  };

  const handleBackgroundMessage = (message: unknown) => {
    const data = message as { type?: string; event?: string; payload?: unknown } | null;
    if (data?.type !== 'bg:event' || typeof data.event !== 'string') return;
    broadcast({
      __lumo: BRIDGE_EVENT,
      event: data.event as BridgeEvent['event'],
      payload: (data.payload ?? {}) as Record<string, unknown>,
    });
  };

  const connectBackground = () => {
    if (disposed || bgPort || bgConnecting) return;
    bgConnecting = true;
    try {
      const port = chrome.runtime.connect({ name: BACKGROUND_PORT_NAME });
      bgPort = port;
      retryDelay = RETRY_MIN_MS;
      port.onMessage.addListener(handleBackgroundMessage);
      port.onDisconnect.addListener(() => {
        bgPort = null;
        // The worker was evicted or the extension reloaded. The RPC channel
        // (sendMessage) still works, so only the event channel needs recovery.
        scheduleReconnect();
      });
      port.postMessage({ type: 'host:ready', payload: { url: location.href } });
      if (bgEverConnected) {
        // Menus and subscriptions live in worker memory; ask engines to replay
        // them after a service-worker restart.
        notifyResume();
      }
      bgEverConnected = true;
    } catch {
      bgPort = null;
      scheduleReconnect();
    } finally {
      bgConnecting = false;
    }
  };

  const sendToBackground = (type: string, payload: Record<string, unknown>): Promise<HostResponse> => {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (response: HostResponse | undefined) => {
          const lastError = chrome.runtime.lastError?.message;
          if (lastError) {
            resolve({ ok: false, error: lastError, code: 'BACKGROUND_UNAVAILABLE' });
            return;
          }
          resolve(
            response ?? {
              ok: false,
              error: 'The background returned an empty response.',
              code: 'BACKGROUND_UNAVAILABLE',
            },
          );
        });
      } catch (error) {
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'BACKGROUND_UNAVAILABLE',
        });
      }
    });
  };

  const handleRpc = async (record: ClientRecord, message: BridgeRpc) => {
    if (!HOST_RPC_TYPES.has(message.type)) {
      postToClient(record, {
        __lumo: BRIDGE_RESULT,
        id: message.id,
        error: `Unsupported bridge request: ${message.type}`,
        code: 'BAD_REQUEST',
      });
      return;
    }

    const response = await sendToBackground(message.type, {
      ...message.payload,
      // The content script knows the current document URL even after a soft
      // navigation; the sender URL reported by the browser does not change.
      __pageUrl: location.href,
    });
    const result: BridgeResult = response.ok
      ? { __lumo: BRIDGE_RESULT, id: message.id, result: response.result }
      : {
          __lumo: BRIDGE_RESULT,
          id: message.id,
          error: String(response.error ?? 'Background request failed.'),
          code: response.code ?? 'HOST_FAILED',
        };
    postToClient(record, result);
  };

  const handleHello = (event: MessageEvent) => {
    if (event.source !== window) return;
    if (!isBridgeHello(event.data) || !event.ports[0]) return;

    const data = event.data;
    const clientId = typeof data.clientId === 'string' && data.clientId ? data.clientId : createId();
    const previous = clients.get(clientId);
    // A reconnect from an engine that already has a slot must never be turned
    // away: it would otherwise retry forever against a full table.
    if (!previous && clients.size >= MAX_CLIENTS) {
      try {
        event.ports[0].close();
      } catch {
        // Nothing else to do.
      }
      return;
    }

    const record: ClientRecord = {
      id: clientId,
      port: event.ports[0],
      kind: typeof data.kind === 'string' ? data.kind : 'unknown',
    };

    if (previous) {
      try {
        previous.port.close();
      } catch {
        // Already gone.
      }
    }
    clients.set(clientId, record);

    record.port.onmessage = (portEvent) => {
      if (!isBridgeRpc(portEvent.data)) return;
      void handleRpc(record, portEvent.data);
    };
    record.port.start();
    record.port.postMessage({
      __lumo: BRIDGE_READY,
      nonce: data.nonce,
      bridgeId,
    });

    // The event port is opened lazily: pages without any active userscript
    // never wake the service worker.
    connectBackground();
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearRetry();
    unbindLifecycle?.();
    window.removeEventListener('message', handleHello);
    for (const record of clients.values()) {
      try {
        record.port.close();
      } catch {
        // Already gone.
      }
    }
    clients.clear();
    if (bgPort) {
      try {
        bgPort.disconnect();
      } catch {
        // Already gone.
      }
      bgPort = null;
    }
  };

  /**
   * Back/forward cache restore.
   *
   * Nothing is injected into a restored document, so the only way the bridge
   * can be whole again is by never having been torn down. Restoring therefore
   * repairs at most the event channel, and only when there is something to
   * repair:
   *
   *  - a document without a single engine handshake stays lazy; a back/forward
   *    trip must not wake the service worker;
   *  - a live port is pinged instead of replaced, because reconnecting would
   *    drop the worker-side registrations, broadcast `menus-changed` and make
   *    every menu row blink for no reason;
   *  - a dead port (worker recycled) is replaced immediately instead of waiting
   *    for the retry backoff, and the existing `notifyResume()` replay tells
   *    every engine to re-register its menus.
   */
  const resumeBackgroundChannel = () => {
    if (disposed) return;
    // The extension was reloaded while the page sat in the cache: the runtime
    // id is gone and no reconnection can ever succeed.
    if (!chrome.runtime?.id) {
      cleanup();
      return;
    }
    if (!bgEverConnected) return;
    if (bgPort) {
      try {
        // Harmless no-id keep-alive; the worker ignores it.
        bgPort.postMessage({ type: 'host:ping' });
        return;
      } catch {
        try {
          bgPort.disconnect();
        } catch {
          // Already gone.
        }
        bgPort = null;
      }
    }
    clearRetry();
    connectBackground();
  };

  window.addEventListener('message', handleHello);

  // `pagehide` is not a terminal signal: a document that enters the
  // back/forward cache keeps its realm and its ports, and nothing is injected
  // into it again on restore. The bridge therefore suspends by doing nothing and
  // only tears down when the document really goes away.
  unbindLifecycle = observePageLifecycle({
    onResume: resumeBackgroundChannel,
    onTerminate: cleanup,
  });
}

function createId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
