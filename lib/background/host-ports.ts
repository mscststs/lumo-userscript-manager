export interface HostPortRecord {
  port: chrome.runtime.Port;
  tabId: number;
  frameId: number;
  url: string;
}

const ports = new Map<string, HostPortRecord>();

function key(tabId: number, frameId: number): string {
  return `${tabId}:${frameId}`;
}

export function registerHostPort(
  port: chrome.runtime.Port,
  sender: chrome.runtime.MessageSender,
): HostPortRecord | null {
  // USER_SCRIPT worlds normally expose sender.tab, but keep a fallback for
  // Chromium builds where the user-script sender omits it. Bootstrap/values
  // still work without a tab id; tab-scoped APIs degrade gracefully.
  const tabId = sender.tab?.id ?? -1;
  if (tabId === -1) {
    console.warn('[Lumo Userscripts] Host port connected without a tab id.');
  }
  const record: HostPortRecord = {
    port,
    tabId,
    frameId: sender.frameId ?? 0,
    url: sender.url ?? sender.tab?.url ?? '',
  };
  ports.set(key(record.tabId, record.frameId), record);
  port.onDisconnect.addListener(() => {
    const current = ports.get(key(record.tabId, record.frameId));
    if (current?.port === port) ports.delete(key(record.tabId, record.frameId));
  });
  return record;
}

export function getHostPort(tabId: number, frameId: number): HostPortRecord | undefined {
  return ports.get(key(tabId, frameId));
}

export function listHostPorts(): HostPortRecord[] {
  return [...ports.values()];
}

export function sendToHost(
  tabId: number,
  frameId: number,
  message: Record<string, unknown>,
): boolean {
  const record = ports.get(key(tabId, frameId));
  if (!record) return false;
  try {
    record.port.postMessage(message);
    return true;
  } catch {
    ports.delete(key(tabId, frameId));
    return false;
  }
}

export function broadcastToHosts(
  message: Record<string, unknown>,
  exclude?: { tabId: number; frameId: number },
): void {
  for (const record of ports.values()) {
    if (exclude && record.tabId === exclude.tabId && record.frameId === exclude.frameId) {
      continue;
    }
    try {
      record.port.postMessage(message);
    } catch {
      ports.delete(key(record.tabId, record.frameId));
    }
  }
}

export function clearHostPortsForTab(tabId: number): void {
  for (const [k, record] of ports) {
    if (record.tabId === tabId) ports.delete(k);
  }
}
