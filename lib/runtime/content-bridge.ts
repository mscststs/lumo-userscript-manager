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

/**
 * The only runtime component that talks to the extension background from a
 * page. It runs as a normal ISOLATED content script, so chrome.runtime behaves
 * like any other extension content script. MAIN/USER_SCRIPT runtimes connect
 * to it over a MessageChannel instead of relying on userScripts-world
 * messaging.
 */
export function startContentBridge(): void {
  let hostPort: MessagePort | null = null;
  let bgPort: chrome.runtime.Port | null = null;
  let bgPingTimer: number | null = null;

  const forwardEvent = (event: string, payload: Record<string, unknown>) => {
    if (!hostPort) return;
    try {
      const message: BridgeEvent = { __lumoBridge: BRIDGE_EVENT, event, payload };
      hostPort.postMessage(message);
    } catch {
      hostPort = null;
    }
  };

  const connectBackground = () => {
    if (bgPort) return;
    try {
      const port = chrome.runtime.connect({ name: 'lumo:host' });
      bgPort = port;
      port.onMessage.addListener((message: any) => {
        if (message?.type === 'bg:event' && typeof message.event === 'string') {
          forwardEvent(message.event, (message.payload ?? {}) as Record<string, unknown>);
        }
      });
      port.onDisconnect.addListener(() => {
        bgPort = null;
        if (bgPingTimer !== null) {
          window.clearInterval(bgPingTimer);
          bgPingTimer = null;
        }
        // The bridge is still usable through one-shot messages. Reconnect the
        // event channel with backoff so a sleeping worker does not spin.
        window.setTimeout(connectBackground, 2_000);
      });
      port.postMessage({ type: 'host:ready', payload: { url: location.href } });
      bgPingTimer = window.setInterval(() => {
        try {
          port.postMessage({ type: 'host:ping', payload: {} });
        } catch {
          // onDisconnect handles recovery.
        }
      }, 20_000);
    } catch {
      bgPort = null;
      window.setTimeout(connectBackground, 2_000);
    }
  };

  const handleRpc = async (message: BridgeRpc) => {
    if (!hostPort) return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: message.type,
        payload: message.payload,
      });
      const result: BridgeResult = response?.ok
        ? { __lumoBridge: BRIDGE_RESULT, id: message.id, result: response.result }
        : {
            __lumoBridge: BRIDGE_RESULT,
            id: message.id,
            error: String(response?.error ?? 'Background request failed.'),
          };
      hostPort.postMessage(result);
    } catch (error) {
      const result: BridgeResult = {
        __lumoBridge: BRIDGE_RESULT,
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      };
      hostPort.postMessage(result);
    }
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as { __lumoBridge?: string; nonce?: string } | null;
    if (data?.__lumoBridge !== BRIDGE_HELLO || !event.ports[0]) return;
    const nonce = data.nonce ?? '';
    hostPort?.close();
    hostPort = event.ports[0];
    hostPort.onmessage = (portEvent) => {
      const message = portEvent.data as BridgeRpc;
      if (message?.__lumoBridge !== BRIDGE_RPC) return;
      void handleRpc(message);
    };
    hostPort.start();
    window.postMessage({ __lumoBridge: BRIDGE_READY, nonce }, '*');
    connectBackground();
  });

  // Keep the worker warm from document_start even when the script itself only
  // runs at document-body or document-idle.
  connectBackground();
}
