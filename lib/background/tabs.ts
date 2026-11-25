/**
 * `GM_getTab` / `GM_saveTab` / `GM_getTabs`.
 *
 * Tampermonkey keeps this state in the session store: it survives same-tab
 * navigations and worker restarts but not a browser restart. A plain module
 * Map (the previous implementation) lost the data whenever the MV3 worker was
 * recycled and leaked entries for closed tabs.
 */

const PREFIX = 'lumo:gm-tab:';

function keyFor(uuid: string, tabId: number): string {
  return `${PREFIX}${uuid}:${tabId}`;
}

function prefixFor(uuid: string): string {
  return `${PREFIX}${uuid}:`;
}

function sessionArea(): chrome.storage.StorageArea {
  return chrome.storage.session ?? chrome.storage.local;
}

export async function getTabState(
  uuid: string,
  tabId: number,
): Promise<Record<string, unknown>> {
  const key = keyFor(uuid, tabId);
  const stored = await sessionArea().get(key);
  const value = stored[key];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export async function saveTabState(
  uuid: string,
  tabId: number,
  value: unknown,
): Promise<void> {
  await sessionArea().set({ [keyFor(uuid, tabId)]: value ?? {} });
}

export async function listTabStates(uuid: string): Promise<Record<string, unknown>> {
  const all = await sessionArea().get(null);
  const prefix = prefixFor(uuid);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(prefix)) result[key.slice(prefix.length)] = value;
  }
  return result;
}

/** Drop state for one tab (called from `chrome.tabs.onRemoved`). */
export async function clearTabStateForTab(tabId: number): Promise<void> {
  const all = await sessionArea().get(null);
  const suffix = `:${tabId}`;
  const keys = Object.keys(all).filter((key) => key.startsWith(PREFIX) && key.endsWith(suffix));
  if (keys.length) await sessionArea().remove(keys);
}

/** Drop every tab state for one script (uninstall / purge). */
export async function clearTabStateForScript(uuid: string): Promise<void> {
  const all = await sessionArea().get(null);
  const prefix = prefixFor(uuid);
  const keys = Object.keys(all).filter((key) => key.startsWith(prefix));
  if (keys.length) await sessionArea().remove(keys);
}
