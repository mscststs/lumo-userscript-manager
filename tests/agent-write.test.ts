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

const WRITE_REVIEW: AgentSettings = {
  enabled: true,
  allowedClients: [{ id: HOST_ID }],
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

  it('refuses to enable a script that still awaits review', async () => {
    const client = await connect(WRITE_REVIEW);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('EnableMe') } }),
    );

    const result = await client.callTool({
      name: 'set_enabled',
      arguments: { ids: [created.script.id], enabled: true },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('REVIEW_REQUIRED');

    const stored = await getScript(created.script.id);
    expect(stored?.enabled).toBe(false);
    expect(stored?.pendingReview).toBe(true);
  });

  it('allows disabling a script that still awaits review', async () => {
    const client = await connect(WRITE_REVIEW);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('KeepDisabled') } }),
    );

    const result = await client.callTool({
      name: 'set_enabled',
      arguments: { ids: [created.script.id], enabled: false },
    });
    expect(result.isError).toBeFalsy();
  });

  it('enables scripts normally when review is off', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('AutoEnable') } }),
    );

    const result = await client.callTool({
      name: 'set_enabled',
      arguments: { ids: [created.script.id], enabled: true },
    });
    expect(result.isError).toBeFalsy();

    const stored = await getScript(created.script.id);
    expect(stored?.enabled).toBe(true);
  });

  it('returns the complete source from get without asking for it', async () => {
    const client = await connect(WRITE_REVIEW);
    const code = codeFor('FullSource');
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code } }),
    );

    const fetched = payloadOf(
      await client.callTool({ name: 'get', arguments: { id: created.script.id } }),
    );
    expect(fetched.found).toBe(true);
    expect(fetched.script.code).toBe(code);
    expect(fetched.script.codeChars).toBe(code.length);
    expect(fetched.script.codeTruncated).toBe(false);
    expect(fetched.script.match).toEqual(['https://example.com/*']);
  });

  it('pages the source only when the caller asks for a window', async () => {
    const client = await connect(WRITE_REVIEW);
    const code = codeFor('Paged');
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code } }),
    );

    const first = payloadOf(
      await client.callTool({
        name: 'get',
        arguments: { id: created.script.id, codeLength: 20 },
      }),
    );
    expect(first.script.code).toBe(code.slice(0, 20));
    expect(first.script.codeOffset).toBe(0);
    expect(first.script.codeLength).toBe(20);
    expect(first.script.codeTruncated).toBe(true);
    expect(first.script.nextOffset).toBe(20);

    const rest = payloadOf(
      await client.callTool({
        name: 'get',
        arguments: { id: created.script.id, codeOffset: first.script.nextOffset },
      }),
    );
    expect(first.script.code + rest.script.code).toBe(code);
    expect(rest.script.codeTruncated).toBe(false);
  });

  it('refuses to guess between scripts that share a name', async () => {
    const client = await connect(WRITE_AUTO);
    const first = payloadOf(
      await client.callTool({
        name: 'create',
        arguments: { code: codeFor('Twin').replace('@namespace test', '@namespace one') },
      }),
    );
    await client.callTool({
      name: 'create',
      arguments: { code: codeFor('Twin').replace('@namespace test', '@namespace two') },
    });

    const ambiguous = await client.callTool({ name: 'get', arguments: { name: 'Twin' } });
    expect(ambiguous.isError).toBe(true);
    const payload = payloadOf(ambiguous);
    expect(payload.code).toBe('AMBIGUOUS');
    expect(payload.candidates).toHaveLength(2);

    const exact = payloadOf(
      await client.callTool({ name: 'get', arguments: { name: 'Twin', namespace: 'one' } }),
    );
    expect(exact.found).toBe(true);
    expect(exact.script.id).toBe(first.script.id);
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
      await client.callTool({ name: 'get', arguments: { id: created.script.id } }),
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

  it('writes the whole source back through update', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('Rewritten') } }),
    );
    const fetched = payloadOf(
      await client.callTool({ name: 'get', arguments: { id: created.script.id } }),
    );

    const next = fetched.script.code.replace("console.log('Rewritten');", "console.log('rewritten');");
    const result = await client.callTool({
      name: 'update',
      arguments: { id: created.script.id, code: next },
    });
    expect(result.isError).toBeFalsy();

    const after = payloadOf(
      await client.callTool({ name: 'get', arguments: { id: created.script.id } }),
    );
    expect(after.script.code).toContain("console.log('rewritten');");
    expect(after.script.codeHash).not.toBe(fetched.script.codeHash);
  });

  it('rejects an update that would break the metadata block', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('BrokenMeta') } }),
    );

    const result = await client.callTool({
      name: 'update',
      arguments: {
        id: created.script.id,
        code: codeFor('BrokenMeta').replace('// @name BrokenMeta\n', ''),
      },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('INVALID_CODE');

    const fetched = payloadOf(
      await client.callTool({ name: 'get', arguments: { id: created.script.id } }),
    );
    expect(fetched.script.code).toContain('// @name BrokenMeta');
  });

  it('applies anchored edits without resending the source', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('Editable') } }),
    );

    const result = await client.callTool({
      name: 'update',
      arguments: {
        id: created.script.id,
        expectedCodeHash: created.script.codeHash,
        edits: [
          { oldText: "console.log('Editable');", newText: "console.log('edited');" },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(payloadOf(result).applied).toEqual([{ strategy: 'exact', line: 7 }]);

    const fetched = payloadOf(
      await client.callTool({ name: 'get', arguments: { id: created.script.id } }),
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
      name: 'update',
      arguments: {
        id: created.script.id,
        edits: [{ oldText: "console.log('same');", newText: "console.log('once');" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('EDIT_FAILED');

    const fetched = payloadOf(
      await client.callTool({ name: 'get', arguments: { id: created.script.id } }),
    );
    expect(fetched.script.code).toContain("console.log('same');");
  });

  it('applies an edit batch atomically', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('Atomic') } }),
    );

    const result = await client.callTool({
      name: 'update',
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
      await client.callTool({ name: 'get', arguments: { id: created.script.id } }),
    );
    expect(fetched.script.code).toContain("console.log('Atomic');");
    expect(fetched.script.code).not.toContain("console.log('first');");
  });

  it('rejects edits that would break the metadata block', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('EditMeta') } }),
    );

    const result = await client.callTool({
      name: 'update',
      arguments: {
        id: created.script.id,
        edits: [{ oldText: '// @name EditMeta', newText: '// removed' }],
      },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('INVALID_CODE');

    const fetched = payloadOf(
      await client.callTool({ name: 'get', arguments: { id: created.script.id } }),
    );
    expect(fetched.script.code).toContain('// @name EditMeta');
  });

  it('rejects edits whose expectedCodeHash is stale', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('EditConflict') } }),
    );

    const result = await client.callTool({
      name: 'update',
      arguments: {
        id: created.script.id,
        expectedCodeHash: 'stale-hash',
        edits: [{ oldText: "console.log('EditConflict');", newText: "console.log('no');" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('CONFLICT');
  });

  it('requires exactly one of code and edits', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('Neither') } }),
    );

    const neither = await client.callTool({ name: 'update', arguments: { id: created.script.id } });
    expect(neither.isError).toBe(true);
    expect(payloadOf(neither).code).toBe('INVALID_INPUT');

    const both = await client.callTool({
      name: 'update',
      arguments: {
        id: created.script.id,
        code: codeFor('Neither'),
        edits: [{ oldText: 'x', newText: 'y' }],
      },
    });
    expect(both.isError).toBe(true);
    expect(payloadOf(both).code).toBe('INVALID_INPUT');
  });

  it('parks an update as disabled pending review when review is on', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('Reviewed') } }),
    );
    expect(created.script.enabled).toBe(true);

    // The user turns review on mid-session; the policy is re-read per call, so
    // the next edit must not run the agent's code unchecked.
    await chrome.storage.local.set({ agentSettings: WRITE_REVIEW });
    const result = payloadOf(
      await client.callTool({
        name: 'update',
        arguments: {
          id: created.script.id,
          edits: [{ oldText: "console.log('Reviewed');", newText: "console.log('pending');" }],
        },
      }),
    );

    expect(result.reviewRequired).toBe(true);
    expect(result.script.enabled).toBe(false);
    expect(result.script.pendingReview).toBe(true);
    expect(result.effectiveOnNextLoad).toBe(false);

    const stored = await getScript(created.script.id);
    expect(stored?.enabled).toBe(false);
    expect(stored?.pendingReview).toBe(true);
  });

  it('refuses to edit a script that is in the recycle bin', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('Trashed') } }),
    );
    await client.callTool({ name: 'delete', arguments: { id: created.script.id } });

    const result = await client.callTool({
      name: 'update',
      arguments: { id: created.script.id, code: codeFor('Trashed') },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('REMOVED');

    const stored = await getScript(created.script.id);
    expect(stored?.removedAt).toBeTruthy();
  });

  it('restores a trashed script', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('BringBack') } }),
    );
    await client.callTool({ name: 'delete', arguments: { id: created.script.id } });

    const result = await client.callTool({ name: 'restore', arguments: { id: created.script.id } });
    expect(result.isError).toBeFalsy();
    expect(payloadOf(result).restored).toBe(true);

    const stored = await getScript(created.script.id);
    expect(stored?.removedAt).toBeUndefined();
    expect(stored?.enabled).toBe(true);
  });

  it('restores a trashed pending script disabled, not approved', async () => {
    const client = await connect(WRITE_REVIEW);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('ReviewedTrash') } }),
    );
    await client.callTool({ name: 'delete', arguments: { id: created.script.id } });

    const result = payloadOf(
      await client.callTool({ name: 'restore', arguments: { id: created.script.id } }),
    );
    expect(result.restored).toBe(true);
    expect(result.reviewRequired).toBe(true);
    expect(result.effectiveOnNextLoad).toBe(false);

    const stored = await getScript(created.script.id);
    expect(stored?.removedAt).toBeUndefined();
    expect(stored?.enabled).toBe(false);
    expect(stored?.pendingReview).toBe(true);

    // The agent still cannot approve it by switching it on.
    const enabling = await client.callTool({
      name: 'set_enabled',
      arguments: { ids: [created.script.id], enabled: true },
    });
    expect(enabling.isError).toBe(true);
    expect(payloadOf(enabling).code).toBe('REVIEW_REQUIRED');
  });

  it('reports a duplicate name as a machine-readable failure', async () => {
    const client = await connect(WRITE_AUTO);
    const code = codeFor('Duplicate');
    await client.callTool({ name: 'create', arguments: { code } });

    const result = await client.callTool({ name: 'create', arguments: { code } });
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.code).toBe('script.duplicate');
    expect(typeof payload.message).toBe('string');
  });

  it('refuses to replace an installed script without its codeHash', async () => {
    const client = await connect(WRITE_AUTO);
    const created = payloadOf(
      await client.callTool({ name: 'create', arguments: { code: codeFor('FromUrl') } }),
    );
    vi.stubGlobal(
      'fetch',
      async () => new Response(codeFor('FromUrl').replace('1.0.0', '2.0.0'), { status: 200 }),
    );

    const conflict = await client.callTool({
      name: 'install',
      arguments: { url: 'https://example.com/from-url.user.js' },
    });
    expect(conflict.isError).toBe(true);
    const payload = payloadOf(conflict);
    expect(payload.code).toBe('CONFLICT');
    expect(payload.existing.id).toBe(created.script.id);

    const replaced = payloadOf(
      await client.callTool({
        name: 'install',
        arguments: {
          url: 'https://example.com/from-url.user.js',
          replaceCodeHash: payload.existing.codeHash,
        },
      }),
    );
    expect(replaced.ok).toBe(true);
    expect(replaced.updated).toBe(true);

    const stored = await getScript(created.script.id);
    expect(stored?.version).toBe('2.0.0');
  });

  it('refuses a replaceCodeHash that matches no installed script', async () => {
    const client = await connect(WRITE_AUTO);
    vi.stubGlobal(
      'fetch',
      async () => new Response(codeFor('FreshInstall'), { status: 200 }),
    );

    const result = await client.callTool({
      name: 'install',
      arguments: {
        url: 'https://example.com/fresh.user.js',
        replaceCodeHash: 'a'.repeat(64),
      },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('NOT_FOUND');

    const payload = payloadOf(
      await client.callTool({
        name: 'install',
        arguments: { url: 'https://example.com/fresh.user.js' },
      }),
    );
    expect(payload.ok).toBe(true);
    expect(payload.updated).toBe(false);
  });

  it('parks an install as disabled pending review when review is on', async () => {
    const client = await connect(WRITE_REVIEW);
    vi.stubGlobal(
      'fetch',
      async () => new Response(codeFor('InstalledReview'), { status: 200 }),
    );

    const payload = payloadOf(
      await client.callTool({
        name: 'install',
        arguments: { url: 'https://example.com/reviewed.user.js' },
      }),
    );
    expect(payload.reviewRequired).toBe(true);
    expect(payload.script.enabled).toBe(false);
    expect(payload.script.pendingReview).toBe(true);
  });

  it('lists with review filters and pages through the index', async () => {
    const client = await connect(WRITE_REVIEW);
    for (const name of ['First', 'Second', 'Third']) {
      await client.callTool({ name: 'create', arguments: { code: codeFor(name) } });
    }

    const firstPage = payloadOf(
      await client.callTool({ name: 'list', arguments: { limit: 2 } }),
    );
    expect(firstPage.total).toBe(3);
    expect(firstPage.returned).toBe(2);
    expect(firstPage.nextOffset).toBe(2);

    const secondPage = payloadOf(
      await client.callTool({ name: 'list', arguments: { offset: 2 } }),
    );
    expect(secondPage.returned).toBe(1);
    expect(secondPage.nextOffset).toBeUndefined();

    const pending = payloadOf(
      await client.callTool({ name: 'list', arguments: { pendingReview: true } }),
    );
    expect(pending.total).toBe(3);

    const reviewed = payloadOf(
      await client.callTool({ name: 'list', arguments: { pendingReview: false } }),
    );
    expect(reviewed.total).toBe(0);
  });

  it('reports runtime counts from diagnostics without a target', async () => {
    const client = await connect(WRITE_REVIEW);
    await client.callTool({ name: 'create', arguments: { code: codeFor('Counted') } });

    const payload = payloadOf(await client.callTool({ name: 'diagnostics', arguments: {} }));
    expect(payload.runtime.userScriptsAvailable).toBe(true);
    expect(payload.counts.total).toBe(1);
    expect(payload.counts.pendingReview).toBe(1);
    expect(payload.errors).toEqual([]);
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
});
