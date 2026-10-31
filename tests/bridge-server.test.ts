import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRIDGE_HELLO, BRIDGE_READY } from '@/lib/runtime/protocol';
import { startContentBridge } from '@/lib/runtime/transport/bridge-server';

interface FakePort {
  closed: boolean;
  posted: unknown[];
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
  start(): void;
}

function createPort(): FakePort {
  return {
    closed: false,
    posted: [],
    onmessage: null,
    postMessage(message: unknown) {
      this.posted.push(message);
    },
    close() {
      this.closed = true;
    },
    start() {
      // No-op.
    },
  };
}

interface FakeWindow {
  __LUMO_BRIDGE_STARTED__?: boolean;
  listeners: Map<string, Set<(event: unknown) => void>>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  dispatch(type: string, event?: unknown): void;
}

function createWindow(): FakeWindow {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    listeners,
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
}

interface FakeRuntimePort {
  posted: unknown[];
  disconnected: boolean;
  dead: boolean;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
  postMessage(message: unknown): void;
  disconnect(): void;
  /** Simulate the service worker being recycled underneath a frozen page. */
  kill(): void;
}

function createRuntimePort(): FakeRuntimePort {
  const disconnectListeners: Array<() => void> = [];
  return {
    posted: [],
    disconnected: false,
    dead: false,
    onMessage: { addListener: () => undefined },
    onDisconnect: {
      addListener: (listener: () => void) => {
        disconnectListeners.push(listener);
      },
    },
    postMessage(message: unknown) {
      // A disconnected `chrome.runtime.Port` throws on use.
      if (this.dead) throw new Error('Attempting to use a disconnected port object');
      this.posted.push(message);
    },
    disconnect() {
      this.disconnected = true;
    },
    kill() {
      this.dead = true;
      for (const listener of disconnectListeners) listener();
    },
  };
}

let fakeWindow: FakeWindow;
let runtimePorts: FakeRuntimePort[];
let connectCalls: number;
let sentMessages: unknown[];

beforeEach(() => {
  fakeWindow = createWindow();
  runtimePorts = [];
  connectCalls = 0;
  sentMessages = [];
  (globalThis as Record<string, unknown>).window = fakeWindow;
  (globalThis as Record<string, unknown>).location = { href: 'https://example.test/page' };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      id: 'test-extension-id',
      connect: () => {
        connectCalls += 1;
        const port = createRuntimePort();
        runtimePorts.push(port);
        return port;
      },
      sendMessage: (message: unknown, callback?: (response: unknown) => void) => {
        sentMessages.push(message);
        callback?.({ ok: true, result: undefined });
      },
      lastError: undefined,
    },
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).location;
  delete (globalThis as Record<string, unknown>).chrome;
});

function handshake(clientId = 'main:1', nonce = 'nonce-1'): FakePort {
  const port = createPort();
  fakeWindow.dispatch('message', {
    source: fakeWindow,
    data: { __lumo: BRIDGE_HELLO, nonce, clientId, kind: 'main' },
    ports: [port],
  });
  return port;
}

describe('startContentBridge', () => {
  it('registers pagehide/pageshow and never the deprecated unload listener', () => {
    startContentBridge();

    expect(fakeWindow.listeners.get('pagehide')?.size).toBe(1);
    expect(fakeWindow.listeners.get('pageshow')?.size).toBe(1);
    // `unload` is blocked by `Permissions-Policy: unload=()` documents and
    // Chrome logs a violation for every listener registration.
    expect(fakeWindow.listeners.get('unload')).toBeUndefined();
  });

  it('closes engine ports when the document really unloads, and only once', () => {
    startContentBridge();

    const port = handshake();
    expect(port.posted).toContainEqual(
      expect.objectContaining({ __lumo: BRIDGE_READY, nonce: 'nonce-1' }),
    );
    expect(port.closed).toBe(false);

    fakeWindow.dispatch('pagehide', { persisted: false });
    expect(port.closed).toBe(true);

    // Calling the teardown twice (e.g. pagehide emitted again) must stay safe.
    expect(() => fakeWindow.dispatch('pagehide', { persisted: false })).not.toThrow();
  });

  it('keeps every channel alive across a back/forward cache round trip', async () => {
    startContentBridge();

    const port = handshake();
    expect(connectCalls).toBe(1);
    const backgroundPort = runtimePorts[0]!;

    fakeWindow.dispatch('pagehide', { persisted: true });
    // Suspending must be a no-op: the document is frozen, not destroyed, and a
    // restore cannot re-inject the content script.
    expect(port.closed).toBe(false);
    expect(backgroundPort.disconnected).toBe(false);

    fakeWindow.dispatch('pageshow', { persisted: true });
    expect(port.closed).toBe(false);
    expect(backgroundPort.disconnected).toBe(false);
    // A healthy port is not replaced: reconnecting would drop the worker-side
    // registrations and make every menu row blink.
    expect(connectCalls).toBe(1);
    expect(backgroundPort.posted).toContainEqual({ type: 'host:ping' });

    // The engine channel still works after the round trip.
    port.onmessage?.({
      data: { __lumo: 'lumo:bridge-rpc', id: 'r1', type: 'host:gm', payload: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentMessages).toContainEqual(
      expect.objectContaining({ type: 'host:gm', payload: expect.anything() }),
    );
  });

  it('reconnects immediately on restore when the worker was recycled', () => {
    startContentBridge();

    const port = handshake();
    expect(connectCalls).toBe(1);
    runtimePorts[0]!.kill();
    // The disconnect handler schedules a backed-off retry; the restore must not
    // wait for it.
    expect(connectCalls).toBe(1);

    fakeWindow.dispatch('pageshow', { persisted: true });
    expect(connectCalls).toBe(2);
    expect(port.closed).toBe(false);

    // The new port announces itself, which is what triggers the menu replay.
    expect(runtimePorts[1]!.posted).toContainEqual(
      expect.objectContaining({ type: 'host:ready' }),
    );
  });

  it('stays lazy for documents without any engine handshake', () => {
    startContentBridge();

    expect(connectCalls).toBe(0);
    fakeWindow.dispatch('pageshow', { persisted: true });
    // A page without matching scripts must never wake the service worker.
    expect(connectCalls).toBe(0);
  });

  it('terminates when the extension was reloaded while the page was frozen', () => {
    startContentBridge();
    const port = handshake();

    (globalThis as Record<string, unknown>).chrome = { runtime: {} };
    fakeWindow.dispatch('pageshow', { persisted: true });

    expect(port.closed).toBe(true);
    expect(fakeWindow.listeners.get('pageshow')?.size).toBe(0);
    expect(fakeWindow.listeners.get('pagehide')?.size).toBe(0);
  });

  it('ignores hello messages from other windows', () => {
    startContentBridge();

    const port = createPort();
    fakeWindow.dispatch('message', {
      source: {},
      data: { __lumo: BRIDGE_HELLO, nonce: 'nonce-2', clientId: 'main:2', kind: 'main' },
      ports: [port],
    });

    expect(port.posted).toHaveLength(0);
    expect(port.closed).toBe(false);
  });

  it('accepts a reconnect from an engine that already holds a slot', () => {
    startContentBridge();

    const first = handshake('main:1', 'nonce-1');
    for (let index = 0; index < 8; index += 1) handshake(`main:extra-${index}`, `nonce-e${index}`);

    // The table is full, but a known client reconnecting (bfcache restore, a
    // new document in the same frame) must not be rejected.
    const retried = handshake('main:1', 'nonce-2');
    expect(retried.posted).toContainEqual(
      expect.objectContaining({ __lumo: BRIDGE_READY, nonce: 'nonce-2' }),
    );
    expect(first.closed).toBe(true);
  });
});
