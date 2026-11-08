import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAuthorize } from '@/lib/agent/authorize';
import { handleProbe } from '@/lib/agent/probe';
import { dismissPendingRequest } from '@/lib/agent/pending';
import { AUTHORIZE_CHANNEL, PROBE_CHANNEL, PROBE_VERSION } from '@/lib/agent/protocol';
import { storage } from '@/store/storage';

/**
 * The L0 split: `lumo:probe` reads, `lumo:authorize` acts.
 *
 * These are the properties that make the split worth having — a probe must be
 * repeatable without consequences, and only authorize may record and prompt.
 * Kept in its own file because `pending.ts` memoises "last opened" at module
 * scope, so sharing a registry with other tests would make the assertions depend
 * on execution order.
 */

const HOST_ID = 'c'.repeat(32);
const store: Record<string, unknown> = {};
const tabsCreate = vi.fn(async () => ({ id: 1 }));

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  tabsCreate.mockClear();
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'b'.repeat(32),
      getManifest: () => ({ version: '0.1.0' }),
      getURL: (path: string) => `chrome-extension://${'b'.repeat(32)}/${path}`,
    },
    tabs: {
      query: async () => [],
      create: tabsCreate,
      update: async () => ({ id: 1 }),
    },
    windows: {
      getLastFocused: async () => ({ id: 1 }),
      update: async () => ({}),
    },
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of list) {
            if (key in store) result[key] = store[key];
          }
          return result;
        },
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        },
      },
    },
    userScripts: { getScripts: async () => [] },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sender = { id: HOST_ID } as chrome.runtime.MessageSender;
const probe = (client?: { id: string; name: string; version: string }) =>
  handleProbe({ channel: PROBE_CHANNEL, version: PROBE_VERSION, client }, sender);
const authorize = (client?: { id: string; name: string; version: string }) =>
  handleAuthorize({ channel: AUTHORIZE_CHANNEL, version: PROBE_VERSION, client }, sender);

/** Let the fire-and-forget prompt path finish before asserting on it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('lumo:probe', () => {
  it('answers without recording anything or opening a window', async () => {
    const response = await probe({ id: HOST_ID, name: 'Lumo', version: '1.0.0' });
    await settle();

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        service: expect.objectContaining({ namespace: 'userscripts', name: 'Lumo Userscripts' }),
        status: expect.objectContaining({ enabled: false, authorized: false, ready: true }),
      }),
    );
    // No approval queue entry, no tab: a probe is a question, not a request.
    expect(await storage.getAgentPendingRequests()).toEqual([]);
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('gives the same answer however often it is asked', async () => {
    const first = await probe();
    const second = await probe();
    const third = await probe();

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(await storage.getAgentPendingRequests()).toEqual([]);
  });

  it('reports authorization once the user has allowed the host', async () => {
    await chrome.storage.local.set({
      agentSettings: { enabled: true, allowedExtensionIds: [HOST_ID] },
    });

    const response = await probe();

    expect(response.status).toEqual(
      expect.objectContaining({ enabled: true, authorized: true, ready: true }),
    );
  });

  it('still answers when the endpoint is switched off', async () => {
    // `ok:true` is what tells the host "installed but off" rather than "absent".
    const response = await probe();
    expect(response.ok).toBe(true);
    expect(response.status?.enabled).toBe(false);
  });
});

describe('lumo:authorize', () => {
  it('records the request and opens the approval card', async () => {
    const response = await authorize({ id: HOST_ID, name: 'Lumo', version: '1.0.0' });
    await settle();

    const pending = await storage.getAgentPendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(expect.objectContaining({ id: HOST_ID, name: 'Lumo' }));
    expect(pending[0]?.promptedAt).toBeTypeOf('number');
    expect(tabsCreate).toHaveBeenCalledTimes(1);
    // The user has not decided yet, so the answer is the same as before asking.
    expect(response.status?.authorized).toBe(false);
  });

  it('does nothing when the host is already allowed', async () => {
    await chrome.storage.local.set({
      agentSettings: { enabled: true, allowedExtensionIds: [HOST_ID] },
    });

    const response = await authorize();
    await settle();

    expect(response.status?.authorized).toBe(true);
    expect(await storage.getAgentPendingRequests()).toEqual([]);
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('prompts again on every request, including after a dismissal', async () => {
    // No cooldown on this path: a click that opens nothing reads as broken.
    await authorize({ id: HOST_ID, name: 'Lumo', version: '1.0.0' });
    await settle();
    const afterFirst = tabsCreate.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // The user dismissed the card; the host asks again.
    await dismissPendingRequest(HOST_ID);
    await authorize({ id: HOST_ID, name: 'Lumo', version: '1.0.0' });
    await settle();

    expect(tabsCreate.mock.calls.length).toBe(afterFirst + 1);
    const pending = await storage.getAgentPendingRequests();
    expect(pending).toHaveLength(1);
    // Revived: the row is actionable again instead of waiting out a cooldown.
    expect(pending[0]?.dismissedAt).toBeUndefined();
  });

  it('keeps one row per caller even when asked repeatedly', async () => {
    await authorize({ id: HOST_ID, name: 'Lumo', version: '1.0.0' });
    await settle();
    await authorize({ id: HOST_ID, name: 'Lumo', version: '2.0.0' });
    await settle();

    const pending = await storage.getAgentPendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.version).toBe('2.0.0');
  });

  it('does not participate at all when the prompt switch is off', async () => {
    // "Open settings when an extension asks" is the master gate: off means this
    // extension is invisible to hosts and never prompts.
    await chrome.storage.local.set({ agentSettings: { promptOnRequest: false } });

    const probed = await probe();
    const authorized = await authorize({ id: HOST_ID, name: 'Lumo', version: '1.0.0' });
    await settle();

    expect(probed.ok).toBe(false);
    expect(probed.error?.code).toBe('REQUESTS_DISABLED');
    expect(authorized.ok).toBe(false);
    expect(await storage.getAgentPendingRequests()).toEqual([]);
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('refuses a newer protocol version', async () => {
    const response = await handleAuthorize(
      { channel: AUTHORIZE_CHANNEL, version: PROBE_VERSION + 1 },
      sender,
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('UNSUPPORTED_PROTOCOL');
    expect(tabsCreate).not.toHaveBeenCalled();
  });
});
