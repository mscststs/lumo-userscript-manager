import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ExtensionHarness } from './chrome-harness';

const enabled = process.env.LUMO_E2E === '1';
const CLIENT_DIR = path.resolve(__dirname, '../fixtures/mcp-client');

/**
 * The agent endpoint, exercised from a second extension.
 *
 * `onConnectExternal` can only be reached by another extension, so this loads
 * the fixture host from `tests/fixtures/mcp-client`, allowlists it in the
 * agent settings and performs a real MCP handshake over the `lumo:mcp` port.
 *
 * Regression guard: the MCP server used to be created with a dynamic
 * `import()`, which is forbidden on `ServiceWorkerGlobalScope` — every session
 * closed immediately ("Connection closed", zero tools).
 */
describe.skipIf(!enabled)('agent endpoint over an external port', () => {
  const harness = new ExtensionHarness();
  afterAll(async () => harness.close());

  it('initializes a session and lists the agent tools', async () => {
    await harness.start();
    const clientId = await harness.loadExtension(CLIENT_DIR);

    // The host must be allowlisted and the endpoint enabled, exactly as the
    // Settings page would leave them.
    await harness.extEval(`(async () => {
      const stored = await chrome.storage.local.get('agentSettings');
      const current = stored.agentSettings ?? {};
      await chrome.storage.local.set({
        agentSettings: {
          ...current,
          enabled: true,
          allowedClients: [
            {
              id: ${JSON.stringify(clientId)},
              name: 'Lumo MCP Test Client',
              version: '1.0.0',
            },
          ],
        },
      });
    })()`);

    const worker = await harness.watchServiceWorker();

    const page = await harness.attachExtensionPage(clientId, 'client.html');
    await new Promise((resolve) => setTimeout(resolve, 300));

    // L0 first: the probe is what lets a host discover this provider at all.
    const probe = await page.send<{
      result: { value: { ok: boolean; service?: { name?: string; version?: string } } };
    }>('Runtime.evaluate', {
      expression: `window.probeAgent(${JSON.stringify(harness.extId)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    expect(probe.result.value.ok).toBe(true);
    expect(probe.result.value.service?.name).toBe('Lumo Userscripts');

    const result = await page.send<{
      result: {
        value: {
          disconnected: string | null;
          initialize: { result?: { serverInfo?: { name?: string }; protocolVersion?: string } } | null;
          tools: string[];
          log: unknown[];
        };
      };
    }>('Runtime.evaluate', {
      expression: `window.mcpHandshake(${JSON.stringify(harness.extId)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    page.close();

    const handshake = result.result.value;
    if (handshake.disconnected) console.error('service worker:', worker.lines);
    worker.close();

    expect(handshake.disconnected).toBeNull();
    expect(handshake.initialize?.result?.serverInfo?.name).toBe('lumo-userscripts');
    expect(handshake.tools.length).toBeGreaterThan(0);
    // The worker must stay clean: a chunk-load failure is what closed the port
    // before, and it surfaced as a `window is not defined` ReferenceError.
    expect(worker.lines.filter((line) => line.startsWith('exception'))).toEqual([]);
  }, 120_000);
});
