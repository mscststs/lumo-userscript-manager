import {
  BRIDGE_HELLO,
  BRIDGE_READY,
  BRIDGE_RESUME,
  BRIDGE_RESULT,
  BRIDGE_RPC,
  isBridgeEvent,
  isBridgeResult,
  type BridgeClientKind,
  type BridgeEvent,
  type BridgeResult,
} from '../protocol';

/**
 * The only window API the client needs. Keeping this narrow makes the
 * handshake state machine testable without a browser.
 */
export interface BridgeScope {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

interface LifecycleScope {
  addEventListener(type: 'pagehide', listener: () => void): void;
  removeEventListener(type: 'pagehide', listener: () => void): void;
}

export interface BridgeClientOptions {
  kind: BridgeClientKind;
  onEvent: (event: BridgeEvent) => void;
  /** Called after the content bridge reconnected to a restarted worker. */
  onResume?: () => void;
  scope?: BridgeScope;
  lifecycle?: LifecycleScope;
  /** Total time to keep retrying the initial handshake. */
  handshakeTimeoutMs?: number;
  /** Delay between handshake attempts (grows to `handshakeRetryMaxMs`). */
  handshakeRetryMs?: number;
  handshakeRetryMaxMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class BridgeError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export class BridgeUnavailableError extends BridgeError {
  constructor(message = 'The content bridge is unavailable.') {
    super(message, 'BRIDGE_UNAVAILABLE');
  }
}

/**
 * Engine-side transport.
 *
 * The handshake is lazy: an engine that is injected into a page without any
 * matching userscript never opens a channel or wakes the service worker.
 */
export class BridgeClient {
  private readonly kind: BridgeClientKind;
  private readonly clientId: string;
  private readonly scope: BridgeScope;
  private readonly lifecycle: LifecycleScope | null;
  private readonly onEvent: (event: BridgeEvent) => void;
  private readonly onResume: (() => void) | undefined;
  private readonly handshakeTimeoutMs: number;
  private readonly handshakeRetryMs: number;
  private readonly handshakeRetryMaxMs: number;

  private port: MessagePort | null = null;
  private nonce = '';
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingCall>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakePort: MessagePort | null = null;
  private retryDelay: number;
  private disposed = false;
  private readonly requestPrefix = Math.random().toString(36).slice(2);

  constructor(options: BridgeClientOptions) {
    this.kind = options.kind;
    this.clientId = `${options.kind}:${Math.random().toString(36).slice(2)}`;
    this.scope = options.scope ?? (window as unknown as BridgeScope);
    this.lifecycle =
      options.lifecycle === undefined
        ? typeof window === 'undefined'
          ? null
          : (window as unknown as LifecycleScope)
        : options.lifecycle;
    this.onEvent = options.onEvent;
    this.onResume = options.onResume;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.handshakeRetryMs = options.handshakeRetryMs ?? 150;
    this.handshakeRetryMaxMs = options.handshakeRetryMaxMs ?? 1_000;
    this.retryDelay = this.handshakeRetryMs;
    this.lifecycle?.addEventListener('pagehide', this.handlePageHide);
  }

  /** Resolves once the isolated content-script bridge accepted this engine. */
  ensureReady(timeoutMs = this.handshakeTimeoutMs): Promise<void> {
    if (this.port) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    if (this.disposed) return Promise.reject(new BridgeUnavailableError('Bridge client disposed.'));

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const deadline = Date.now() + Math.max(0, timeoutMs);
    const attempt = () => {
      if (this.disposed) {
        rejectReady(new BridgeUnavailableError('Bridge client disposed.'));
        return;
      }
      if (Date.now() >= deadline) {
        this.clearRetry();
        this.handshakePort?.close();
        this.handshakePort = null;
        this.acceptReady = null;
        this.readyPromise = null;
        rejectReady(new BridgeUnavailableError('Timed out waiting for the content bridge.'));
        return;
      }

      const nonce = `n-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.nonce = nonce;
      const channel = new MessageChannel();
      this.handshakePort = channel.port1;
      channel.port1.onmessage = (event) => this.handlePortMessage(event.data);
      channel.port1.start();

      try {
        this.scope.postMessage(
          {
            __lumo: BRIDGE_HELLO,
            nonce,
            clientId: this.clientId,
            kind: this.kind,
          },
          '*',
          [channel.port2],
        );
      } catch (error) {
        channel.port1.close();
        this.handshakePort = null;
        this.readyPromise = null;
        rejectReady(
          error instanceof Error ? error : new BridgeUnavailableError(String(error)),
        );
        return;
      }

      this.clearRetry();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.port) return;
        channel.port1.close();
        this.handshakePort = null;
        this.retryDelay = Math.min(this.retryDelay * 2, this.handshakeRetryMaxMs);
        attempt();
      }, this.retryDelay);
      this.acceptReady = () => {
        this.port = channel.port1;
        this.handshakePort = null;
        this.clearRetry();
        this.retryDelay = this.handshakeRetryMs;
        resolveReady();
      };
    };

    attempt();
    return this.readyPromise;
  }

  /**
   * Send an RPC through the content bridge. `timeoutMs = 0` means "wait until
   * the background responds or the port closes" (GM_xmlhttpRequest can take a
   * long time).
   */
  async call<T = unknown>(
    type: string,
    payload: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    await this.ensureReady();
    const port = this.port;
    if (!port) throw new BridgeUnavailableError();

    const id = `${this.requestPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = options.timeoutMs ?? 0;

    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              const entry = this.pending.get(id);
              if (!entry) return;
              this.pending.delete(id);
              entry.reject(new BridgeError(`Request timed out: ${type}`, 'RPC_TIMEOUT'));
            }, timeoutMs)
          : null;

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        port.postMessage({ __lumo: BRIDGE_RPC, id, type, payload } satisfies {
          __lumo: typeof BRIDGE_RPC;
          id: string;
          type: string;
          payload: Record<string, unknown>;
        });
      } catch (error) {
        this.pending.delete(id);
        if (timer !== null) clearTimeout(timer);
        this.resetPort(new BridgeUnavailableError('The content bridge port closed.'));
        reject(error instanceof Error ? error : new BridgeUnavailableError(String(error)));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle?.removeEventListener('pagehide', this.handlePageHide);
    this.resetPort(new BridgeUnavailableError('Bridge client disposed.'));
  }

  private acceptReady: (() => void) | null = null;

  private handlePageHide = () => {
    this.dispose();
  };

  private clearRetry() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private handlePortMessage(data: unknown) {
    if (isBridgeResult(data)) {
      this.handleResult(data);
      return;
    }
    if (isBridgeEvent(data)) {
      this.onEvent(data);
      return;
    }
    const ready = data as { __lumo?: string; nonce?: string } | null;
    if (ready?.__lumo === BRIDGE_READY) {
      if (ready.nonce !== this.nonce) return;
      this.acceptReady?.();
      this.acceptReady = null;
      return;
    }
    if (ready?.__lumo === BRIDGE_RESUME) {
      this.onResume?.();
    }
  }

  private handleResult(message: BridgeResult) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new BridgeError(message.error, message.code ?? 'HOST_ERROR'));
    } else {
      entry.resolve(message.result);
    }
  }

  private resetPort(reason: Error) {
    this.clearRetry();
    if (this.handshakePort) {
      this.handshakePort.onmessage = null;
      try {
        this.handshakePort.close();
      } catch {
        // Already closed.
      }
      this.handshakePort = null;
    }
    this.retryDelay = this.handshakeRetryMs;
    if (this.port) {
      this.port.onmessage = null;
      try {
        this.port.close();
      } catch {
        // Already closed.
      }
    }
    this.port = null;
    this.readyPromise = null;
    this.acceptReady = null;
    this.nonce = '';
    for (const entry of this.pending.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
  }
}
