import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  optionsUrl,
  planOptionsOpen,
  type OptionsTabLike,
} from '@/lib/options-tab';

const base = 'chrome-extension://lumo/options.html';

function tab(overrides: OptionsTabLike & { id: number }): OptionsTabLike {
  return { windowId: 1, active: false, lastAccessed: 0, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('options tab planner', () => {
  it('creates a tab when the manager is not open', () => {
    expect(planOptionsOpen([], base, `${base}#/scripts`)).toEqual({ kind: 'create' });
  });

  it('ignores tabs that are not the manager', () => {
    const tabs = [
      tab({ id: 1, url: 'https://example.com/' }),
      tab({ id: 2, url: 'chrome-extension://lumo/popup.html' }),
      // A different extension's options page must not be hijacked.
      tab({ id: 3, url: 'chrome-extension://other/options.html' }),
      tab({ id: 4 }),
    ];
    expect(planOptionsOpen(tabs, base, `${base}#/scripts`)).toEqual({ kind: 'create' });
  });

  it('focuses an existing tab that already shows the requested route', () => {
    const tabs = [tab({ id: 7, url: `${base}#/script/abc`, windowId: 2 })];
    expect(planOptionsOpen(tabs, base, `${base}#/script/abc`)).toEqual({
      kind: 'focus',
      tabId: 7,
      windowId: 2,
    });
  });

  it('navigates an existing tab sitting on another route', () => {
    const tabs = [tab({ id: 7, url: `${base}#/scripts` })];
    expect(planOptionsOpen(tabs, base, `${base}#/script/abc`)).toEqual({
      kind: 'navigate',
      tabId: 7,
      windowId: 1,
      url: `${base}#/script/abc`,
    });
  });

  it('treats the bare manager URL as a route of its own', () => {
    expect(planOptionsOpen([tab({ id: 7, url: base })], base, base)).toMatchObject({
      kind: 'focus',
      tabId: 7,
    });
    expect(planOptionsOpen([tab({ id: 7, url: `${base}#/scripts` })], base, base)).toMatchObject({
      kind: 'navigate',
      tabId: 7,
      url: base,
    });
  });

  it('prefers the tab already on the target route over a more recent one', () => {
    const tabs = [
      tab({ id: 1, url: `${base}#/scripts`, active: true, lastAccessed: 900 }),
      tab({ id: 2, url: `${base}#/logs`, lastAccessed: 100 }),
    ];
    expect(planOptionsOpen(tabs, base, `${base}#/logs`)).toMatchObject({
      kind: 'focus',
      tabId: 2,
    });
  });

  it('prefers the most recently used duplicate when several are open', () => {
    const tabs = [
      tab({ id: 1, url: `${base}#/scripts`, lastAccessed: 100 }),
      tab({ id: 2, url: `${base}#/scripts`, active: true, lastAccessed: 200 }),
      tab({ id: 3, url: `${base}#/logs`, lastAccessed: 300 }),
    ];
    expect(planOptionsOpen(tabs, base, `${base}#/about`)).toMatchObject({
      kind: 'navigate',
      tabId: 2,
    });
  });

  it('focuses a tab showing a deeper panel of the requested route', () => {
    const tabs = [tab({ id: 5, url: `${base}#/script/abc/metadata` })];
    expect(planOptionsOpen(tabs, base, `${base}#/script/abc`)).toMatchObject({
      kind: 'focus',
      tabId: 5,
    });
  });

  it('does not confuse sibling routes that share a prefix', () => {
    const tabs = [tab({ id: 5, url: `${base}#/scripts` })];
    expect(planOptionsOpen(tabs, base, `${base}#/script`)).toMatchObject({
      kind: 'navigate',
      tabId: 5,
    });
  });

  it('prefers the last focused window before the active tab elsewhere', () => {
    const tabs = [
      tab({ id: 1, url: `${base}#/scripts`, windowId: 1, active: true, lastAccessed: 900 }),
      tab({ id: 2, url: `${base}#/logs`, windowId: 2, lastAccessed: 100 }),
    ];
    expect(planOptionsOpen(tabs, base, `${base}#/about`, 2)).toMatchObject({
      kind: 'navigate',
      tabId: 2,
    });
  });

  it('falls back to creation when no options tab can be identified', () => {
    const tabs = [tab({ id: 1, url: `${base}#/scripts`, lastAccessed: 900 }), { url: base }];
    expect(planOptionsOpen(tabs, base, `${base}#/logs`)).toMatchObject({
      kind: 'navigate',
      tabId: 1,
    });
  });
});

describe('options url', () => {
  it('builds the absolute options URL with and without a route', () => {
    vi.stubGlobal('chrome', {
      runtime: { getURL: (path: string) => `chrome-extension://lumo/${path}` },
    });

    expect(optionsUrl()).toBe('chrome-extension://lumo/options.html');
    expect(optionsUrl('#/scripts')).toBe('chrome-extension://lumo/options.html#/scripts');
    // Accept a hash written without its leading `#`.
    expect(optionsUrl('/settings/agent')).toBe(
      'chrome-extension://lumo/options.html#/settings/agent',
    );
  });
});
