import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_EVENT,
  BRIDGE_HELLO,
  BRIDGE_READY,
  BRIDGE_RESUME,
  BRIDGE_RESULT,
  BRIDGE_RPC,
} from '@/lib/runtime/protocol';
import {
  BridgeClient,
  BridgeUnavailableError,
  type BridgeScope,
} from '@/lib/runtime/transport/bridge-client';
import type { PageLifecycleScope } from '@/lib/runtime/lifecycle';

interface FakeServerOptions {
  ignoreHellos?: number;
  answerRpc?: (type: string, payload: Record<string, unknown>) => unknown;
}

class FakeScope implements BridgeScope {
  server: ((message: any, port: MessagePort) => void) | null = null;

  postMessage(message: unknown, _targetOrigin: string, transfer?: Transferable[]): void {
    const data = message as { __lumo?: string };
    const port = transfer?.[0] as MessagePort | undefined;
    if (data?.__lumo === BRIDGE_HELLO && port) this.server?.(message, port);
  }
}

function createServer(scope: FakeScope, options: FakeServerOptions = {}) {
  const clients = new Set<MessagePort>();
  let helloCount = 0;

  scope.server = (message: any, port: MessagePort) => {
    helloCount += 1;
    if (options.ignoreHellos && helloCount <= options.ignoreHellos) {
      port.close();
      return;
    }
    port.onmessage = (event) => {
      const data = event.data;
      if (data?.__lumo !== BRIDGE_RPC) return;
      if (!options.answerRpc) return;
      const result = options.answerRpc(data.type, data.payload);
      port.postMessage({ __lumo: BRIDGE_RESULT, id: data.id, result });
    };
    port.start();
    port.postMessage({ __lumo: BRIDGE_READY, nonce: message.nonce, bridgeId: 'test' });
    clients.add(port);
  };

  return {
    get helloCount() {
      return helloCount;
    },
    sendEvent(event: string, payload: Record<string, unknown>) {
      for (const port of clients) {
        port.postMessage({ __lumo: BRIDGE_EVENT, event, payload });
      }
    },
    sendResume() {
      for (const port of clients) port.postMessage({ __lumo: BRIDGE_RESUME });
    },
  };
}

function createClient(
  scope: FakeScope,
  options: {
    onEvent?: () => void;
    onResume?: () => void;
    lifecycle?: PageLifecycleScope | null;
  } = {},
) {
  return new BridgeClient({
    kind: 'main',
    scope,
    onEvent: options.onEvent ?? (() => undefined),
    onResume: options.onResume,
    lifecycle: options.lifecycle ?? null,
    handshakeTimeoutMs: 1_000,
    handshakeRetryMs: 10,
    handshakeRetryMaxMs: 40,
  });
}

describe('BridgeClient', () => {
  it('handshakes and resolves RPCs', async () => {
    const scope = new FakeScope();
    createServer(scope, { answerRpc: (type, payload) => ({ type, payload }) });
    const client = createClient(scope);

    await expect(client.call('echo', { value: 1 })).resolves.toEqual({
      type: 'echo',
      payload: { value: 1 },
    });
    client.dispose();
  });

  it('retries the handshake until the bridge is injected', async () => {
    const scope = new FakeScope();
    const server = createServer(scope, {
      ignoreHellos: 3,
      answerRpc: () => 'ok',
    });
    const client = createClient(scope);

    await expect(client.call('anything', {})).resolves.toBe('ok');
    expect(server.helloCount).toBeGreaterThanOrEqual(4);
    client.dispose();
  });

  it('fails fast when no bridge ever answers', async () => {
    const scope = new FakeScope();
    const client = new BridgeClient({
      kind: 'userscript',
      scope,
      onEvent: () => undefined,
      handshakeTimeoutMs: 80,
      handshakeRetryMs: 10,
    });

    await expect(client.call('anything', {})).rejects.toBeInstanceOf(BridgeUnavailableError);
    client.dispose();
  });

  it('times out an individual RPC without dropping the port', async () => {
    const scope = new FakeScope();
    const server = createServer(scope, {});
    const client = createClient(scope);

    await expect(client.call('slow', {}, { timeoutMs: 40 })).rejects.toMatchObject({
      code: 'RPC_TIMEOUT',
    });
    expect(server.helloCount).toBe(1);
    client.dispose();
  });

  it('delivers events and resume notifications', async () => {
    const scope = new FakeScope();
    const server = createServer(scope, { answerRpc: () => 'ok' });
    const onEvent = vi.fn();
    const onResume = vi.fn();
    const client = createClient(scope, { onEvent, onResume });

    await client.call('ping', {});
    server.sendEvent('menu-command', { uuid: 'u1', id: 'm1' });
    server.sendResume();

    await vi.waitFor(() => {
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'menu-command', payload: { uuid: 'u1', id: 'm1' } }),
      );
      expect(onResume).toHaveBeenCalledTimes(1);
    });
    client.dispose();
  });

  it('rejects pending calls when disposed', async () => {
    const scope = new FakeScope();
    const server = createServer(scope, {});
    const client = createClient(scope);

    await client.ensureReady();
    expect(server.helloCount).toBe(1);
    const pending = client.call('never', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.dispose();
    await expect(pending).rejects.toBeInstanceOf(BridgeUnavailableError);
  });
});

class FakeLifecycle implements PageLifecycleScope {
  private readonly listeners = new Map<string, Set<(event: PageTransitionEvent) => void>>();

  addEventListener(type: 'pagehide' | 'pageshow', listener: (event: PageTransitionEvent) => void): void {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(
    type: 'pagehide' | 'pageshow',
    listener: (event: PageTransitionEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  suspend(): void {
    for (const listener of [...(this.listeners.get('pagehide') ?? [])]) {
      listener({ persisted: true } as PageTransitionEvent);
    }
  }

  restore(): void {
    for (const listener of [...(this.listeners.get('pageshow') ?? [])]) {
      listener({ persisted: true } as PageTransitionEvent);
    }
  }

  terminate(): void {
    for (const listener of [...(this.listeners.get('pagehide') ?? [])]) {
      listener({ persisted: false } as PageTransitionEvent);
    }
  }

  count(): number {
    let total = 0;
    for (const bucket of this.listeners.values()) total += bucket.size;
    return total;
  }
}

describe('BridgeClient page lifecycle', () => {
  it('keeps the channel across a back/forward cache round trip', async () => {
    const scope = new FakeScope();
    const server = createServer(scope, { answerRpc: (type) => type });
    const lifecycle = new FakeLifecycle();
    const onResume = vi.fn();
    const client = createClient(scope, { onResume, lifecycle });

    await expect(client.call('ping', {})).resolves.toBe('ping');
    lifecycle.suspend();
    // A frozen document keeps its port: the runtime was never torn down.
    await expect(client.call('ping', {})).resolves.toBe('ping');

    lifecycle.restore();
    expect(server.helloCount).toBe(1);
    // A healthy port needs no replay: the registrations never went away.
    expect(onResume).not.toHaveBeenCalled();
    client.dispose();
  });

  it('rebuilds a lost channel and replays after a restore', async () => {
    const scope = new FakeScope();
    const server = createServer(scope, { answerRpc: () => 'ok' });
    const lifecycle = new FakeLifecycle();
    const onResume = vi.fn();
    const client = createClient(scope, { onResume, lifecycle });

    await client.ensureReady();
    expect(server.helloCount).toBe(1);

    // Simulates a transport that dropped while the page was frozen.
    (
      client as unknown as { resetPort: (reason: Error) => void }
    ).resetPort(new BridgeUnavailableError('port lost'));

    lifecycle.restore();
    await vi.waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(server.helloCount).toBe(2);
    client.dispose();
  });

  it('stays lazy on restore when it never connected', async () => {
    const scope = new FakeScope();
    const server = createServer(scope, { answerRpc: () => 'ok' });
    const lifecycle = new FakeLifecycle();
    const onResume = vi.fn();
    const client = createClient(scope, { onResume, lifecycle });

    lifecycle.restore();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A document without matching scripts must not wake the worker.
    expect(server.helloCount).toBe(0);
    expect(onResume).not.toHaveBeenCalled();
    client.dispose();
  });

  it('disposes on a real unload and stops listening', async () => {
    const scope = new FakeScope();
    createServer(scope, { answerRpc: () => 'ok' });
    const lifecycle = new FakeLifecycle();
    const onResume = vi.fn();
    const client = createClient(scope, { onResume, lifecycle });

    await client.call('ping', {});
    lifecycle.terminate();

    await expect(client.call('ping', {})).rejects.toBeInstanceOf(BridgeUnavailableError);
    expect(lifecycle.count()).toBe(0);
    lifecycle.restore();
    expect(onResume).not.toHaveBeenCalled();
  });
});
