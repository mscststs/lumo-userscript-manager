import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP transport over a `chrome.runtime.Port`.
 *
 * A Port is a persistent duplex message channel, which is the same shape as
 * MCP's stdio transport. The only subtlety is authorization: the port is opened
 * by the host before we know whether it is allowed, so messages that arrive
 * during the policy check are buffered here and replayed by `start()`.
 */
export class ChromePortTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private active = false;
  private closed = false;
  private pending: JSONRPCMessage[] = [];

  constructor(private readonly port: chrome.runtime.Port) {
    port.onMessage.addListener(this.handleMessage);
    port.onDisconnect.addListener(this.handleDisconnect);
  }

  async start(): Promise<void> {
    this.active = true;
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) this.onmessage?.(message);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('The agent port is closed.');
    try {
      this.port.postMessage(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.port.disconnect();
    } catch {
      // Already disconnected; nothing to do.
    }
    this.onclose?.();
  }

  private handleMessage = (message: unknown): void => {
    if (this.closed) return;
    if (!this.active) {
      this.pending.push(message as JSONRPCMessage);
      return;
    }
    this.onmessage?.(message as JSONRPCMessage);
  };

  private handleDisconnect = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  };
}
