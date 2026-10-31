import { describe, expect, it, vi } from 'vitest';
import { createGmApi, type GmTransport } from '@/lib/runtime/gm-api';

function makeTransport(): GmTransport & {
  call: ReturnType<typeof vi.fn>;
  registerMenuCommand: ReturnType<typeof vi.fn>;
  unregisterMenuCommand: ReturnType<typeof vi.fn>;
} {
  return {
    call: vi.fn(async () => undefined),
    log: vi.fn(),
    registerMenuCommand: vi.fn(async () => 'menu-1'),
    unregisterMenuCommand: vi.fn(async () => undefined),
  } as any;
}

function makeContext(grant: string[]) {
  const transport = makeTransport();
  const api = createGmApi({
    grant,
    meta: { name: ['Example'], namespace: ['demo'], grant },
    metaStr: '// ==UserScript==',
    handlerVersion: '0.1.0',
    sandboxMode: 'raw',
    values: { saved: 1 },
    resources: {},
    transport,
    window: { navigator: { userAgent: 'test', platform: 'test' } } as any,
    document: {
      createElement: () => ({ setAttribute() {}, textContent: '' }),
      head: { appendChild() {} },
      documentElement: { appendChild() {} },
    } as any,
  });
  return { api, transport };
}

describe('GM API scoping', () => {
  it('exposes only granted legacy and GM4 APIs', () => {
    const { api } = makeContext(['GM_getValue', 'GM_setValue']);
    expect(api.GM.GM_getValue).toBeTypeOf('function');
    expect(api.GM.GM_setValue).toBeTypeOf('function');
    expect(api.GM.GM_deleteValue).toBeUndefined();
    expect(api.GM.GM.getValue).toBeTypeOf('function');
    expect(api.GM.GM.setValue).toBeTypeOf('function');
    expect(api.GM.GM.deleteValue).toBeUndefined();
    expect(api.GM.GM_info.scriptHandler).toBe('Lumo Userscripts');
  });

  it('reads and writes the local value snapshot', () => {
    const { api, transport } = makeContext(['GM_getValue', 'GM_setValue']);
    expect(api.GM.GM_getValue('saved')).toBe(1);
    api.GM.GM_setValue('next', 2);
    expect(api.GM.GM_getValue('next')).toBe(2);
    expect(transport.call).toHaveBeenCalledWith('GM_setValue', ['next', 2]);
  });

  it('fires value-change listeners with remote state', () => {
    const { api } = makeContext(['GM_addValueChangeListener', 'GM_removeValueChangeListener']);
    const listener = vi.fn();
    const id = api.GM.GM_addValueChangeListener('key', listener);
    api.emitValueChanged('key', 0, 1, true);
    expect(listener).toHaveBeenCalledWith('key', 0, 1, true);
    api.GM.GM_removeValueChangeListener(id);
    api.emitValueChanged('key', 1, 2, true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not expose granted APIs with @grant none, but keeps unsafeWindow and GM_info', () => {
    const { api } = makeContext(['none']);
    expect(api.GM.GM_info).toBeDefined();
    expect(api.GM.unsafeWindow).toBeDefined();
    expect(api.GM.GM_setValue).toBeUndefined();
    expect(api.GM.GM.getValue).toBeUndefined();
  });

  it('exposes unsafeWindow even without an explicit grant', () => {
    const { api } = makeContext(['GM_setValue']);
    expect(api.GM.unsafeWindow).toBeDefined();
  });

  it('reports resources and script metadata in GM_info', () => {
    const { api } = makeContext(['GM_info']);
    expect(api.GM_info.script.resources).toEqual([]);
    expect(api.GM_info.script.grant).toContain('GM_info');
  });

  it('uses the explicit page-realm unsafeWindow when provided', () => {
    const unsafeWindow = { marker: 'page' } as any;
    const transport = makeTransport();
    const api = createGmApi({
      grant: ['GM_setValue'],
      meta: { name: ['Example'], namespace: ['demo'] },
      metaStr: '',
      handlerVersion: '0.1.0',
      sandboxMode: 'raw',
      values: {},
      resources: {},
      transport,
      window: { navigator: { userAgent: 'test', platform: 'test' } } as any,
      document: { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, documentElement: { appendChild() {} } } as any,
      unsafeWindow,
    });
    expect(api.GM.unsafeWindow).toBe(unsafeWindow);
  });

  it('keys menu commands by options.id or title so frames can be merged', async () => {
    const { api, transport } = makeContext(['GM_registerMenuCommand']);

    const byTitle = await api.GM.GM_registerMenuCommand('Toggle panel', () => {});
    expect(byTitle).toBe('Toggle panel');
    expect(transport.registerMenuCommand).toHaveBeenCalledWith('Toggle panel', 'Toggle panel', undefined);

    // A legacy string third argument is an access key, not an id.
    const withAccessKey = await api.GM.GM_registerMenuCommand('Other', () => {}, 'o');
    expect(withAccessKey).toBe('Other');
    expect(transport.registerMenuCommand).toHaveBeenLastCalledWith('Other', 'Other', { accessKey: 'o' });

    // GM4's explicit id wins, and is stable across frames.
    const explicit = await api.GM.GM_registerMenuCommand('Third', () => {}, { id: 'cmd-3' });
    expect(explicit).toBe('cmd-3');
  });

  it('unregisters a menu command by its id or by its title', async () => {
    const { api, transport } = makeContext(['GM_registerMenuCommand', 'GM_unregisterMenuCommand']);
    await api.GM.GM_registerMenuCommand('By title', () => {});
    await api.GM.GM_unregisterMenuCommand('By title');
    expect(transport.unregisterMenuCommand).toHaveBeenLastCalledWith('By title');

    await api.GM.GM_registerMenuCommand('With id', () => {}, { id: 'cmd-9' });
    await api.GM.GM_unregisterMenuCommand('cmd-9');
    expect(transport.unregisterMenuCommand).toHaveBeenLastCalledWith('cmd-9');

    // An unknown key must not reach the background.
    const calls = transport.unregisterMenuCommand.mock.calls.length;
    await api.GM.GM_unregisterMenuCommand('missing');
    expect(transport.unregisterMenuCommand.mock.calls.length).toBe(calls);
  });

  it('passes the log level and labels through GM_log', () => {
    const { api, transport } = makeContext(['GM_log']);
    api.GM.GM_log('message', 'warn', 'label');
    expect(transport.log).toHaveBeenCalledWith('warn', ['message', 'label']);
  });
});
