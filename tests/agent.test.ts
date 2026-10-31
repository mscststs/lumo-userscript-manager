import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createAgentMcpServer } from '@/lib/agent/mcp-server';
import { handleProbe } from '@/lib/agent/probe';
import {
  PROBE_CHANNEL,
  PROBE_VERSION,
  isExtensionId,
  isProbeRequest,
} from '@/lib/agent/protocol';
import { analyzeScriptCode } from '@/lib/script/analyze';
import { approvePendingRequest } from '@/lib/agent/pending';
import { storage } from '@/store/storage';
import { ChromePortTransport } from '@/lib/agent/transport';
import { STORAGE_FIELDS, normalizeAgentPendingRequests } from '@/store/storage-schema';

const HOST_ID = 'c'.repeat(32);
const READ_SETTINGS = {
  enabled: true,
  allowedExtensionIds: [HOST_ID],
  allowWrites: false,
  reviewWrites: true,
  promptOnRequest: false,
};
const WRITE_SETTINGS = { ...READ_SETTINGS, allowWrites: true };
const store: Record<string, unknown> = {};

function installChromeStub(): void {
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'b'.repeat(32),
      getManifest: () => ({ version: '0.1.0' }),
      getURL: (path: string) => `chrome-extension://${'b'.repeat(32)}/${path}`,
    },
    tabs: {
      query: async () => [],
      create: async () => ({ id: 1 }),
      update: async () => ({ id: 1 }),
    },
    windows: {
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
    userScripts: {
      getScripts: async () => [],
    },
  });
}

/** In-memory pair of MCP transports; each send is delivered to the peer. */
class MemoryTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  peer?: MemoryTransport;

  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    const peer = this.peer;
    queueMicrotask(() => peer?.onmessage?.(message));
  }
  async close(): Promise<void> {
    this.onclose?.();
  }
}

function transportPair(): [MemoryTransport, MemoryTransport] {
  const server = new MemoryTransport();
  const client = new MemoryTransport();
  server.peer = client;
  client.peer = server;
  return [server, client];
}


class Emitter<T extends (...args: never[]) => void> {
  private listeners = new Set<T>();
  addListener = (listener: T) => {
    this.listeners.add(listener);
  };
  removeListener = (listener: T) => {
    this.listeners.delete(listener);
  };
  emit = (...args: Parameters<T>) => {
    for (const listener of [...this.listeners]) listener(...args);
  };
}

/** Minimal stand-in for a `chrome.runtime.Port` pair. */
class FakePort {
  peer?: FakePort;
  onMessage = new Emitter<(message: unknown) => void>();
  onDisconnect = new Emitter<() => void>();

  postMessage(message: unknown): void {
    queueMicrotask(() => this.peer?.onMessage.emit(message));
  }

  disconnect(): void {
    queueMicrotask(() => {
      this.onDisconnect.emit();
      this.peer?.onDisconnect.emit();
    });
  }
}

function fakePortPair(): [FakePort, FakePort] {
  const left = new FakePort();
  const right = new FakePort();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

/** Host-side transport over the fake port (mirrors lib/mcp/transports). */
class TestClientTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private active = false;

  constructor(private readonly port: FakePort) {
    port.onMessage.addListener((message) => {
      if (this.active) this.onmessage?.(message as JSONRPCMessage);
    });
    port.onDisconnect.addListener(() => this.onclose?.());
  }

  async start(): Promise<void> {
    this.active = true;
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.port.postMessage(message);
  }
  async close(): Promise<void> {
    this.port.disconnect();
  }
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  installChromeStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent probe contract', () => {
  it('validates the envelope', () => {
    expect(isProbeRequest({ channel: PROBE_CHANNEL, version: PROBE_VERSION })).toBe(true);
    expect(isProbeRequest({ channel: 'other', version: 1 })).toBe(false);
    expect(isProbeRequest(null)).toBe(false);
    expect(isExtensionId('a'.repeat(32))).toBe(true);
    expect(isExtensionId('z'.repeat(32))).toBe(false);
  });

  it('deny-by-default answers even when disabled', async () => {
    const response = await handleProbe(
      { channel: PROBE_CHANNEL, version: PROBE_VERSION },
      { id: HOST_ID } as chrome.runtime.MessageSender,
    );
    expect(response.ok).toBe(true);
    expect(response.status).toEqual(
      expect.objectContaining({ enabled: false, authorized: false, ready: true }),
    );
  });

  it('records an unknown caller as a pending request', async () => {
    await handleProbe(
      { channel: PROBE_CHANNEL, version: PROBE_VERSION, client: { id: HOST_ID, name: 'Lumo', version: '1.0.0' } },
      { id: HOST_ID } as chrome.runtime.MessageSender,
    );
    const pending = await storage.getAgentPendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(
      expect.objectContaining({ id: HOST_ID, name: 'Lumo' }),
    );
  });

  it('approves a pending request by enabling access and allowlisting it', async () => {
    await handleProbe(
      { channel: PROBE_CHANNEL, version: PROBE_VERSION },
      { id: HOST_ID } as chrome.runtime.MessageSender,
    );
    const next = await approvePendingRequest(HOST_ID);
    expect(next).toEqual(
      expect.objectContaining({ enabled: true, allowedExtensionIds: [HOST_ID] }),
    );
    expect(await storage.getAgentPendingRequests()).toEqual([]);
  });

  it('reports enabled + authorized after the user opts in', async () => {
    await chrome.storage.local.set({
      agentSettings: { enabled: true, allowedExtensionIds: [HOST_ID] },
    });
    const response = await handleProbe(
      { channel: PROBE_CHANNEL, version: PROBE_VERSION },
      { id: HOST_ID } as chrome.runtime.MessageSender,
    );
    expect(response.status).toEqual(
      expect.objectContaining({ enabled: true, authorized: true, ready: true }),
    );
  });

  it('refuses a newer probe version but still identifies itself', async () => {
    const response = await handleProbe(
      { channel: PROBE_CHANNEL, version: PROBE_VERSION + 1 },
      { id: HOST_ID } as chrome.runtime.MessageSender,
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('UNSUPPORTED_PROTOCOL');
    expect(response.service?.namespace).toBe('userscripts');
  });

  it('normalizes and caps pending access requests', () => {
    const rows = normalizeAgentPendingRequests([
      { id: HOST_ID, name: 'Lumo', lastSeen: 2 },
      { id: 'not-an-id', name: 'Bad' },
      { id: HOST_ID, name: 'Duplicate' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ id: HOST_ID }));
  });

  it('normalizes the allowlist', () => {
    const normalize = STORAGE_FIELDS.agentSettings.normalize!;
    const result = normalize({
      enabled: true,
      allowedExtensionIds: [HOST_ID, 'not-an-id', HOST_ID, 7],
    } as never);
    expect(result).toEqual({
      enabled: true,
      allowedExtensionIds: [HOST_ID],
      allowWrites: true,
      reviewWrites: false,
      promptOnRequest: true,
    });
  });
});

describe('agent MCP server', () => {
  it('speaks standard MCP: initialize instructions + tools/list', async () => {
    const [serverTransport, clientTransport] = transportPair();
    const server = createAgentMcpServer(HOST_ID, READ_SETTINGS);
    await server.connect(serverTransport);

    const client = new Client({ name: 'contract-test', version: '1.0.0' });
    await client.connect(clientTransport);

    expect(client.getInstructions()).toContain('read-only');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['list', 'get', 'diagnostics']);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);

    await client.close();
    await server.close();
  });

  it('exposes write tools only when the policy allows writes', async () => {
    const [serverTransport, clientTransport] = transportPair();
    const server = createAgentMcpServer(HOST_ID, WRITE_SETTINGS);
    await server.connect(serverTransport);

    const client = new Client({ name: 'contract-test', version: '1.0.0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'list',
      'get',
      'diagnostics',
      'set_enabled',
      'create',
      'edit',
      'update',
      'install',
      'delete',
    ]);
    expect(client.getInstructions()).toContain('create, edit, enable/disable');

    await client.close();
    await server.close();
  });

  it('runs a tool over the runtime Port transport', async () => {
    await chrome.storage.local.set({
      agentSettings: { enabled: true, allowedExtensionIds: [HOST_ID] },
    });

    const [serverPort, clientPort] = fakePortPair();
    const server = createAgentMcpServer(HOST_ID, READ_SETTINGS);
    await server.connect(
      new ChromePortTransport(serverPort as unknown as chrome.runtime.Port),
    );

    const client = new Client({ name: 'port-test', version: '1.0.0' });
    await client.connect(new TestClientTransport(clientPort));

    const result = await client.callTool({
      name: 'get',
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ text?: string }>;
    expect(JSON.parse(content[0]?.text ?? '{}').found).toBe(false);

    await client.close();
    await server.close();
  });
});

describe('script analysis', () => {
  const code = `// ==UserScript==
// @name Demo
// @namespace demo
// @version 1.0.0
// @match https://example.com/*
// @grant none
// ==/UserScript==
console.log('hi');`;

  it('parses a valid script', () => {
    const result = analyzeScriptCode(code);
    expect(result.ok).toBe(true);
    expect(result.metadata.name).toBe('Demo');
    expect(result.metadata.match).toEqual(['https://example.com/*']);
    expect(result.warnings).toEqual([]);
  });

  it('warns about missing match rules and unsupported tags', () => {
    const result = analyzeScriptCode(`// ==UserScript==
// @name Demo
// @background
// @grant GM_futureThing
// ==/UserScript==`);
    expect(result.ok).toBe(true);
    expect(result.warnings.join('\n')).toContain('No @match or @include rule');
    expect(result.warnings.join('\n')).toContain('Unsupported @grant');
    expect(result.warnings.join('\n')).toContain('@background is not supported');
  });

  it('reports a missing metadata block as an error', () => {
    const result = analyzeScriptCode('console.log(1)');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('No ==UserScript== metadata block');
  });
});
