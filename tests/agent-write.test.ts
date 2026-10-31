// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { AgentSettings } from '@/types';

const HOST_ID = 'c'.repeat(32);
const store: Record<string, unknown> = {};

const RUNTIME = {
  userScriptsAvailable: true,
  scriptsEnabled: true,
  registeredCount: 0,
  engineCount: 0,
  lastCheckedAt: 0,
};

// The write path only needs the domain layer; re-registration and badge
// decoration are Chrome-side effects covered by the integration suite.
vi.mock('@/lib/background/registry', () => ({
  requestRegistration: async () => RUNTIME,
  getRuntimeStatus: () => RUNTIME,
  checkUserScriptsAvailable: async () => ({ ok: true }),
}));

const { createAgentMcpServer } = await import('@/lib/agent/mcp-server');
const { clearStore, getScript, listAgentAudit } = await import('@/lib/db');
const { resetWriteLimit, consumeWrite, WRITE_LIMIT, WRITE_WINDOW_MS } = await import(
  '@/lib/agent/rate-limit'
);

const WRITE_REVIEW: AgentSettings = {
  enabled: true,
  allowedExtensionIds: [HOST_ID],
  allowWrites: true,
  reviewWrites: true,
  promptOnRequest: false,
};
const WRITE_AUTO: AgentSettings = { ...WRITE_REVIEW, reviewWrites: false };

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

function pair(): [MemoryTransport, MemoryTransport] {
  const server = new MemoryTransport();
  const client = new MemoryTransport();
  server.peer = client;
  client.peer = server;
  return [server, client];
}

function codeFor(name: string): string {
  return `// ==UserScript==
// @name ${name}
// @namespace test
// @version 1.0.0
// @match https://example.com/*
// ==/UserScript==
console.log('${name}');`;
}

function payloadOf(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return JSON.parse(content[0]?.text ?? '{}') as Record<string, any>;
}

const closers: Array<() => Promise<void>> = [];

async function connect(settings: AgentSettings): Promise<Client> {
  // `resolveAgentAccess` reads the live policy per call, so the storage record
  // must match the settings the server was registered with.
  await chrome.storage.local.set({ agentSettings: settings });
  const [serverTransport, clientTransport] = pair();
  const server = createAgentMcpServer(HOST_ID, settings);
  await server.connect(serverTransport);
  const client = new Client({ name: 'write-test', version: '1.0.0' });
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

beforeEach(async () => {
  for (const key of Object.keys(store)) delete store[key];
  for (const name of [
    'scripts',
    'code',
    'versions',
    'resources',
    'icons',
    'values',
    'drafts',
    'agentAudit',
  ]) {
    try {
      await clearStore(name);
    } catch {
      // Store may not exist before the first open.
    }
  }
  resetWriteLimit();

  vi.stubGlobal('chrome', {
    runtime: {
      id: 'b'.repeat(32),
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: async () => undefined,
    },
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of list) if (key in store) result[key] = store[key];
          return result;
        },
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        },
      },
    },
  });
});

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  vi.unstubAllGlobals();
});

describe('agent write tools', () => {
  it('creates a disabled pending-review script when review is on', async () => {
    const client = await connect(WRITE_REVIEW);
    const result = await client.callTool({
      name: 'create',
      arguments: { code: codeFor('Reviewed') },
    });

    expect(result.isError).toBeFalsy();
    const payload = payloadOf(result);
    expect(payload.reviewRequired).toBe(true);
    expect(payload.script.enabled).toBe(false);
    expect(payload.script.pendingReview).toBe(true);

    const stored = await getScript(payload.script.id);
    expect(stored?.enabled).toBe(false);
    expect(stored?.pendingReview).toBe(true);
  });

  it('rejects invalid metadata on create instead of requiring a separate validate call', async () => {
    const client = await connect(WRITE_REVIEW);
    const result = await client.callTool({
      name: 'create',
      arguments: { code: 'console.log(1)' },
    });

    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.code).toBe('INVALID_CODE');
    expect((payload.errors as string[])[0]).toContain('No ==UserScript== metadata block');
  });

  it('creates an enabled script when review is off', async () => {
    const client = await connect(WRITE_AUTO);
    const result = await client.callTool({
      name: 'create',
      arguments: { code: codeFor('Auto') },
    });

    const payload = payloadOf(result);
    expect(payload.reviewRequired).toBe(false);
    expect(payload.script.enabled).toBe(true);
    expect(payload.script.pendingReview).toBeUndefined();
  });

  it('clears pendingReview when the user/agent enables the script', async () => {
    const client = await connect(WRITE_REVIEW);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('EnableMe') } }),
    );

    const result = await client.callTool({
      name: 'set_enabled',
      arguments: { ids: [created.script.id], enabled: true },
    });
    expect(result.isError).toBeFalsy();

    const stored = await getScript(created.script.id);
    expect(stored?.enabled).toBe(true);
    expect(stored?.pendingReview).toBeUndefined();
  });

  it('rejects an update whose expectedCodeHash is stale', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('Conflict') } }),
    );

    const result = await client.callTool({
      name: 'update',
      arguments: {
        id: created.script.id,
        code: codeFor('Conflict'),
        expectedCodeHash: 'stale-hash',
      },
    });

    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.code).toBe('CONFLICT');
    expect(typeof payload.currentCodeHash).toBe('string');
  });

  it('updates code when the hash matches', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('Stable') } }),
    );
    const fetched = payloadOf(
      await client.callTool({
        name: 'get',
        arguments: { id: created.script.id, includeCode: true },
      }),
    );

    const result = await client.callTool({
      name: 'update',
      arguments: {
        id: created.script.id,
        code: codeFor('Stable'),
        expectedCodeHash: fetched.script.codeHash,
      },
    });
    expect(result.isError).toBeFalsy();
  });

  it('edits code with anchored replacements', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('Editable') } }),
    );

    const result = await client.callTool({
      name: 'edit',
      arguments: {
        id: created.script.id,
        expectedCodeHash: created.script.codeHash,
        edits: [
          {
            oldText: "console.log('Editable');",
            newText: "console.log('edited');",
          },
        ],
      },
    });
    expect(result.isError).toBeFalsy();

    const fetched = payloadOf(
      await client.callTool({
        name: 'get',
        arguments: { id: created.script.id, includeCode: true },
      }),
    );
    expect(fetched.script.code).toContain("console.log('edited');");
    expect(fetched.script.code).not.toContain("console.log('Editable');");
  });

  it('rejects an ambiguous anchor and leaves the script untouched', async () => {
    const client = await connect(WRITE_AUTO);
    const source = codeFor('Ambiguous').replace(
      "console.log('Ambiguous');",
      "console.log('same');\nconsole.log('same');",
    );
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: source } }),
    );

    const result = await client.callTool({
      name: 'edit',
      arguments: {
        id: created.script.id,
        edits: [{ oldText: "console.log('same');", newText: "console.log('once');" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('EDIT_FAILED');

    const fetched = payloadOf(
      await client.callTool({
        name: 'get',
        arguments: { id: created.script.id, includeCode: true },
      }),
    );
    expect(fetched.script.code).toContain("console.log('same');");
  });

  it('applies a batch atomically', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('Atomic') } }),
    );

    const result = await client.callTool({
      name: 'edit',
      arguments: {
        id: created.script.id,
        edits: [
          { oldText: "console.log('Atomic');", newText: "console.log('first');" },
          { oldText: 'this text does not exist', newText: 'x' },
        ],
      },
    });
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.code).toBe('EDIT_FAILED');
    expect(payload.index).toBe(1);

    const fetched = payloadOf(
      await client.callTool({
        name: 'get',
        arguments: { id: created.script.id, includeCode: true },
      }),
    );
    expect(fetched.script.code).toContain("console.log('Atomic');");
    expect(fetched.script.code).not.toContain("console.log('first');");
  });

  it('rejects an edit that would break the metadata block', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('BrokenMeta') } }),
    );

    const result = await client.callTool({
      name: 'edit',
      arguments: {
        id: created.script.id,
        edits: [{ oldText: '// @name BrokenMeta', newText: '// removed' }],
      },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('INVALID_CODE');

    const fetched = payloadOf(
      await client.callTool({
        name: 'get',
        arguments: { id: created.script.id, includeCode: true },
      }),
    );
    expect(fetched.script.code).toContain('// @name BrokenMeta');
  });

  it('rejects an edit whose expectedCodeHash is stale', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('EditConflict') } }),
    );

    const result = await client.callTool({
      name: 'edit',
      arguments: {
        id: created.script.id,
        expectedCodeHash: 'stale-hash',
        edits: [{ oldText: "console.log('EditConflict');", newText: "console.log('no');" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('CONFLICT');
  });

  it('moves a script to the trash instead of purging it', async () => {
    const client = await connect(WRITE_REVIEW);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('TrashMe') } }),
    );

    const result = await client.callTool({
      name: 'delete',
      arguments: { id: created.script.id },
    });
    expect(result.isError).toBeFalsy();

    const stored = await getScript(created.script.id);
    expect(stored).toBeDefined();
    expect(stored?.removedAt).toBeTruthy();
  });

  it('audits writes without storing the source', async () => {
    const client = await connect(WRITE_REVIEW);
    await client.callTool({ name: 'create', arguments: { code: codeFor('Audited') } });

    const audit = await listAgentAudit(10);
    expect(audit.some((entry) => entry.tool === 'create' && entry.result === 'ok')).toBe(true);
    expect(audit.every((entry) => entry.argsHash.length === 64)).toBe(true);
  });

  it('rate-limits write calls', () => {
    for (let index = 0; index < WRITE_LIMIT; index += 1) {
      expect(consumeWrite('sender')).toBe(true);
    }
    expect(consumeWrite('sender')).toBe(false);
    // A different sender has its own bucket.
    expect(consumeWrite('other')).toBe(true);
    expect(WRITE_WINDOW_MS).toBe(60_000);
  });
});
