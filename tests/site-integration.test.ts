// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Site compatibility is the only place where the extension intentionally
 * answers a page. The tests pin the three halves of that contract:
 *
 *  - the lookup decides what "installed" means (name first, stable URL id as
 *    the rename-proof fallback);
 *  - the isolated channel publishes the opt-in and never runs off-site;
 *  - the page script claims the probe early, answers nothing while the feature
 *    is off, and never takes a name another manager already owns.
 */

const db = vi.hoisted(() => ({
  findByNameNamespace: vi.fn(),
  listScripts: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  findByNameNamespace: db.findByNameNamespace,
  listScripts: db.listScripts,
}));

const store = vi.hoisted(() => ({ siteIntegration: true }));

vi.mock('@/store/storage', () => ({
  storage: {
    getUISettings: () =>
      Promise.resolve({ siteIntegration: store.siteIntegration }),
  },
}));

const bridge = vi.hoisted(() => ({
  calls: [] as { type: string; payload: Record<string, unknown>; options?: unknown }[],
  result: { installed: false } as { installed: boolean; version?: string },
  failure: null as Error | null,
  disposed: 0,
}));

vi.mock('@/lib/runtime/transport/bridge-client', () => {
  class BridgeUnavailableError extends Error {}
  class BridgeClient {
    constructor(readonly options: unknown) {}
    call(type: string, payload: Record<string, unknown>, options?: unknown) {
      bridge.calls.push({ type, payload, options });
      if (bridge.failure) return Promise.reject(bridge.failure);
      return Promise.resolve(bridge.result);
    }
    dispose() {
      bridge.disposed += 1;
    }
  }
  return { BridgeClient, BridgeUnavailableError };
});

import { lookupInstalledScript } from '@/lib/background/site-lookup';
import {
  createManagerProbe,
  createOptInGate,
  startSiteExposure,
  type SiteExposureHandle,
} from '@/lib/site-integration/expose';
import {
  isSiteStateMessage,
  isSupportedSiteHost,
  scriptSiteKey,
  SITE_STATE,
  type SiteStateMessage,
} from '@/lib/site-integration/protocol';
import { startSiteStateChannel, type SiteStateScope } from '@/lib/site-integration/state';
import { BRIDGE_HELLO, isBridgeHello } from '@/lib/runtime/protocol';

const PAGE = 'https://greasyfork.org/zh-CN/scripts/448434-b%E7%AB%99%E8%AF%84%E8%AE%BA%E5%8C%BA%E5%BC%80%E7%9B%92';

describe('site probe protocol', () => {
  it('recognises the two script sites and their subdomains only', () => {
    expect(isSupportedSiteHost('greasyfork.org')).toBe(true);
    expect(isSupportedSiteHost('update.greasyfork.org')).toBe(true);
    expect(isSupportedSiteHost('sleazyfork.org')).toBe(true);
    expect(isSupportedSiteHost('example.com')).toBe(false);
    expect(isSupportedSiteHost('notgreasyfork.org')).toBe(false);
  });

  it('derives the stable script id from page and install URLs alike', () => {
    expect(scriptSiteKey(PAGE)).toBe('greasyfork:448434');
    expect(scriptSiteKey('https://update.greasyfork.org/scripts/448434/Some%20Name.user.js')).toBe(
      'greasyfork:448434',
    );
    expect(scriptSiteKey('https://greasyfork.org/scripts/448434/code')).toBe('greasyfork:448434');
    expect(
      scriptSiteKey('https://update.greasyfork.org/scripts/448434/Some.user.js?version=123'),
    ).toBe('greasyfork:448434');
  });

  it('ignores pages and URLs without a script id', () => {
    expect(scriptSiteKey('https://greasyfork.org/scripts/by-site/example.com')).toBeNull();
    expect(scriptSiteKey('https://example.com/scripts/1/x.user.js')).toBeNull();
    expect(scriptSiteKey('not a url')).toBeNull();
    expect(scriptSiteKey(undefined)).toBeNull();
  });

  it('only accepts the state message it sends', () => {
    expect(isSiteStateMessage({ __lumo: SITE_STATE, enabled: true })).toBe(true);
    expect(isSiteStateMessage({ __lumo: SITE_STATE, enabled: false })).toBe(true);
    expect(isSiteStateMessage({ __lumo: SITE_STATE, enabled: 'yes' })).toBe(false);
    expect(isSiteStateMessage({ __lumo: 'other', enabled: true })).toBe(false);
  });

  it('lets the page channel through the bridge handshake', () => {
    // Regression: the page channel was typed but rejected by `isBridgeHello`,
    // which left every probe waiting for a handshake that never completed.
    expect(
      isBridgeHello({ __lumo: BRIDGE_HELLO, nonce: 'n', clientId: 'page:x', kind: 'page' }),
    ).toBe(true);
    expect(
      isBridgeHello({ __lumo: BRIDGE_HELLO, nonce: 'n', clientId: 'x', kind: 'unknown' }),
    ).toBe(false);
  });
});

describe('site lookup', () => {
  beforeEach(() => {
    store.siteIntegration = true;
    db.findByNameNamespace.mockReset().mockResolvedValue(undefined);
    db.listScripts.mockReset().mockResolvedValue([]);
  });

  it('never answers while the feature is off, even for a direct bridge caller', async () => {
    // A script on the site can speak the bridge protocol without going through
    // the page-world gate, so the settings read is the authoritative check.
    store.siteIntegration = false;
    db.findByNameNamespace.mockResolvedValue({ version: '1.02' });
    await expect(
      lookupInstalledScript({ name: 'B站评论区开盒', namespace: 'mscststs', pageUrl: PAGE }),
    ).resolves.toEqual({ installed: false });
    expect(db.findByNameNamespace).not.toHaveBeenCalled();
  });

  it('never answers for a page outside the supported sites', async () => {
    await expect(
      lookupInstalledScript({ name: 'x', namespace: 'y', pageUrl: 'https://example.com/' }),
    ).resolves.toEqual({ installed: false });
    expect(db.findByNameNamespace).not.toHaveBeenCalled();
  });

  it('matches the installed script by name and namespace', async () => {
    db.findByNameNamespace.mockResolvedValue({ version: '1.02' });
    await expect(
      lookupInstalledScript({ name: 'B站评论区开盒', namespace: 'mscststs', pageUrl: PAGE }),
    ).resolves.toEqual({ installed: true, version: '1.02' });
    // Recycled scripts are not installed, so the bin must stay excluded.
    expect(db.findByNameNamespace).toHaveBeenCalledWith('B站评论区开盒', 'mscststs', false);
  });

  it('falls back to the script id when the site renamed the script', async () => {
    db.findByNameNamespace.mockResolvedValue(undefined);
    db.listScripts.mockResolvedValue([
      {
        origin: 'https://update.greasyfork.org/scripts/448434/Old%20Name.user.js',
        downloadUrl: '',
        updateUrl: '',
        version: '2.0',
      },
    ]);
    await expect(
      lookupInstalledScript({ name: 'New Name', namespace: 'ns', pageUrl: PAGE }),
    ).resolves.toEqual({ installed: true, version: '2.0' });
    expect(db.listScripts).toHaveBeenCalledWith(false);
  });

  it('reports an install without a version instead of inventing one', async () => {
    db.findByNameNamespace.mockResolvedValue({ version: '' });
    await expect(
      lookupInstalledScript({ name: 'x', namespace: '', pageUrl: PAGE }),
    ).resolves.toEqual({ installed: true });
  });

  it('does not scan the table when the page has no script id', async () => {
    db.findByNameNamespace.mockResolvedValue(undefined);
    await expect(
      lookupInstalledScript({
        name: 'x',
        namespace: 'y',
        pageUrl: 'https://greasyfork.org/zh-CN/scripts/by-site/example.com',
      }),
    ).resolves.toEqual({ installed: false });
    expect(db.listScripts).not.toHaveBeenCalled();
  });
});

describe('opt-in gate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles a pending probe on the first answer', async () => {
    const gate = createOptInGate(2000);
    const pending = gate.isEnabled();
    gate.set(true);
    await expect(pending).resolves.toBe(true);
    gate.dispose();
  });

  it('assumes off when the channel never answers', async () => {
    vi.useFakeTimers();
    const gate = createOptInGate(2000);
    const pending = gate.isEnabled();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBe(false);
    gate.dispose();
  });

  it('follows later changes after the first answer', async () => {
    const gate = createOptInGate(2000);
    gate.set(true);
    gate.set(false);
    await expect(gate.isEnabled()).resolves.toBe(false);
    gate.dispose();
  });
});

describe('manager probe', () => {
  it('answers null without touching the lookup while the feature is off', async () => {
    const lookup = vi.fn();
    const probe = createManagerProbe({ isEnabled: () => Promise.resolve(false), lookup });
    await expect(probe.isInstalled('Example', 'ns')).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('normalises the site arguments to strings before the lookup', async () => {
    const lookup = vi.fn().mockResolvedValue('1.0');
    const probe = createManagerProbe({ isEnabled: () => Promise.resolve(true), lookup });
    await expect(probe.isInstalled(42, null)).resolves.toBe('1.0');
    expect(lookup).toHaveBeenCalledWith('', '');
  });
});

describe('site state channel', () => {
  interface FakeStateScope extends SiteStateScope {
    posted: SiteStateMessage[];
    request(): void;
    change(enabled: boolean): void;
  }

  function createScope(overrides: Partial<SiteStateScope> = {}): FakeStateScope {
    const posted: SiteStateMessage[] = [];
    let requestListener: (() => void) | null = null;
    let changeListener: ((enabled: boolean) => void) | null = null;
    return {
      hostname: 'greasyfork.org',
      isTopFrame: true,
      readOptIn: () => Promise.resolve(true),
      onOptInChange(listener) {
        changeListener = listener;
      },
      onPageRequest(listener) {
        requestListener = listener;
      },
      post(message) {
        posted.push(message);
      },
      posted,
      request() {
        requestListener?.();
      },
      change(enabled) {
        changeListener?.(enabled);
      },
      ...overrides,
    };
  }

  it('publishes the stored value, answers requests and follows changes', async () => {
    const scope = createScope();
    startSiteStateChannel(scope);
    await Promise.resolve();

    expect(scope.posted).toEqual([{ __lumo: SITE_STATE, enabled: true }]);
    scope.request();
    expect(scope.posted.at(-1)).toEqual({ __lumo: SITE_STATE, enabled: true });
    scope.change(false);
    expect(scope.posted.at(-1)).toEqual({ __lumo: SITE_STATE, enabled: false });
  });

  it('stays inert on unsupported hosts and in child frames', async () => {
    const offSite = createScope({ hostname: 'example.com' });
    startSiteStateChannel(offSite);
    await Promise.resolve();
    expect(offSite.posted).toHaveLength(0);

    const childFrame = createScope({ isTopFrame: false });
    startSiteStateChannel(childFrame);
    await Promise.resolve();
    expect(childFrame.posted).toHaveLength(0);
  });
});

describe('site exposure', () => {
  let handle: SiteExposureHandle | null = null;

  const external = () => (window as unknown as { external?: Record<string, unknown> }).external;

  const announce = (enabled: boolean) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { __lumo: SITE_STATE, enabled },
        source: window,
      }),
    );
  };

  beforeEach(() => {
    bridge.calls.length = 0;
    bridge.result = { installed: false };
    bridge.failure = null;
    bridge.disposed = 0;
    delete (window as unknown as { external?: unknown }).external;
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    delete (window as unknown as { external?: unknown }).external;
  });

  it('claims the probe before the first paint so the site never misses it', () => {
    // Greasy Fork probes once and retries once, one second later. Waiting for
    // the settings round trip before claiming the name lost that race.
    handle = startSiteExposure();
    expect(external()?.Violentmonkey).toBeDefined();
  });

  it('answers null for a probe captured before the opt-in is known to be off', async () => {
    handle = startSiteExposure();
    const manager = external()?.Violentmonkey as {
      isInstalled(name: string, namespace?: string): Promise<string | null>;
    };
    const pending = manager.isInstalled('x', '');
    announce(false);
    await expect(pending).resolves.toBeNull();
    expect(external()?.Violentmonkey).toBeUndefined();
    expect(bridge.calls).toHaveLength(0);
  });

  it('answers the probe with the installed version', async () => {
    bridge.result = { installed: true, version: '1.02' };
    handle = startSiteExposure();
    announce(true);

    const manager = external()?.Violentmonkey as {
      isInstalled(name: string, namespace?: string): Promise<string | null>;
    };
    await expect(manager.isInstalled('B站评论区开盒', 'mscststs')).resolves.toBe('1.02');
    expect(bridge.calls.at(-1)).toMatchObject({
      type: 'site:lookup',
      payload: { name: 'B站评论区开盒', namespace: 'mscststs' },
    });
  });

  it('answers null when the script has no version or the bridge is down', async () => {
    handle = startSiteExposure();
    announce(true);
    const manager = external()?.Violentmonkey as {
      isInstalled(name: string, namespace?: string): Promise<string | null>;
    };

    bridge.result = { installed: true };
    await expect(manager.isInstalled('x', '')).resolves.toBeNull();

    bridge.failure = new Error('bridge down');
    await expect(manager.isInstalled('x', '')).resolves.toBeNull();
  });

  it('withdraws the probe and drops the channel when the opt-in is turned off', async () => {
    bridge.result = { installed: true, version: '1.0' };
    handle = startSiteExposure();
    announce(true);
    const manager = external()?.Violentmonkey as {
      isInstalled(name: string, namespace?: string): Promise<string | null>;
    };
    await manager.isInstalled('x', '');
    expect(bridge.disposed).toBe(0);

    announce(false);
    expect(external()?.Violentmonkey).toBeUndefined();
    expect(bridge.disposed).toBe(1);
  });

  it('never replaces a manager that already owns the name', () => {
    const existing = { isInstalled: () => Promise.resolve('other') };
    (window as unknown as { external: Record<string, unknown> }).external = {
      Violentmonkey: existing,
    };
    handle = startSiteExposure();
    announce(true);
    announce(false);
    expect(external()?.Violentmonkey).toBe(existing);
    handle.stop();
    expect(external()?.Violentmonkey).toBe(existing);
  });
});
