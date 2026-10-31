import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { canRunChromeE2E, ExtensionHarness } from './chrome-harness';

const enabled = canRunChromeE2E();

/**
 * Regression tests for the two surfaces that are easy to get wrong and hard to
 * see: the toolbar badge (a per-tab number Chrome clears on every navigation)
 * and menu commands (registered once per frame).
 *
 * Run with:
 *   npm run build
 *   LUMO_E2E=1 npm test -- tests/integration
 *
 * Both cases used to fail with the real browser:
 *  - reloading a page whose script count did not change left the badge empty,
 *    because the worker believed the old text was still painted;
 *  - a page with four iframes showed five identical menu commands.
 */
describe.skipIf(!enabled)('badge and menu commands across frames', () => {
  const harness = new ExtensionHarness();
  let server: Server;
  let base = '';
  let tabId = 0;
  let alwaysUuid = '';

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const badge = async () =>
    harness.extEval<string>(`chrome.action.getBadgeText({ tabId: ${tabId} })`);

  const menus = async () => harness.menuCommands(tabId);

  async function waitFor<T>(fn: () => Promise<T | false>, timeoutMs = 8_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | false = false;
    while (Date.now() < deadline) {
      last = await fn();
      if (last !== false) return last;
      await sleep(150);
    }
    throw new Error(`Timed out waiting (last=${JSON.stringify(last)})`);
  }

  async function goto(path: string): Promise<void> {
    const url = base + path;
    await harness.pageEval(`location.href = ${JSON.stringify(url)}`);
    await harness.waitForPage(
      `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`,
      15_000,
    );
    // Let every frame finish registering and reporting.
    await sleep(1200);
  }

  async function runCount(uuid: string): Promise<number> {
    return harness.extEval<number>(`(async () => {
      const response = await chrome.runtime.sendMessage({
        type: 'scripts:list',
        payload: { includeRemoved: true },
      });
      return response.result.find((item) => item.uuid === ${JSON.stringify(uuid)}).runCount;
    })()`);
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url?.startsWith('/frames')) {
        response.end(
          `<!doctype html><html><body><h1>frames</h1>${'<iframe src="/frame"></iframe>'.repeat(4)}</body></html>`,
        );
        return;
      }
      response.end('<!doctype html><html><body><h1>plain</h1></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server has no port.');
    base = `http://127.0.0.1:${address.port}`;

    await harness.start();
    await harness.openPage();
    tabId = await harness.tabId();

    alwaysUuid = await harness.installScript(`// ==UserScript==
// @name         Always
// @namespace    e2e-badge
// @version      1.0.0
// @match        ${base}/*
// @grant        GM_registerMenuCommand
// ==/UserScript==
document.documentElement.dataset.always = '1';
GM_registerMenuCommand('E2E menu', () => {
  document.documentElement.dataset.menu = 'clicked';
});
`);
    await harness.installScript(`// ==UserScript==
// @name         Only
// @namespace    e2e-badge
// @version      1.0.0
// @match        ${base}/only/*
// @grant        none
// ==/UserScript==
document.documentElement.dataset.only = '1';
`);

    await harness.refresh();
    await sleep(800);
  }, 90_000);

  afterAll(async () => {
    await harness.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('keeps the badge in sync across navigations and reloads', async () => {
    await goto('/plain');
    expect(await waitFor(async () => ((await badge()) === '1' ? '1' : false))).toBe('1');

    await goto('/only/x');
    expect(await waitFor(async () => ((await badge()) === '2' ? '2' : false))).toBe('2');

    await goto('/plain');
    expect(await waitFor(async () => ((await badge()) === '1' ? '1' : false))).toBe('1');

    // The regression: a reload clears the tab's badge, and the count does not
    // change, so a "last painted text" cache used to leave it blank forever.
    await harness.reloadPage();
    await sleep(1200);
    expect(await waitFor(async () => ((await badge()) === '1' ? '1' : false))).toBe('1');
    expect(await harness.pageEval(`document.documentElement.dataset.always`)).toBe('1');

    // The reported state is mirrored into session storage so a respawned
    // worker still knows what this tab is running.
    const stored = await harness.extEval<{ injectedFrames?: Record<string, unknown> }>(
      `chrome.storage.session.get('injectedFrames')`,
    );
    const frames = Object.values(
      (stored.injectedFrames ?? {}) as Record<string, Record<string, { script: string[] } | unknown>>,
    );
    expect(frames.length).toBeGreaterThan(0);
    const reported = frames.flatMap((frame) =>
      Object.values(frame as Record<string, { scripts?: string[] }>).flatMap(
        (item) => item?.scripts ?? [],
      ),
    );
    expect(reported).toContain(alwaysUuid);

    // Switching the script off drops it at once; turning it back on cannot
    // invent a run the document never performed — that is a reload away.
    await harness.extEval(
      `chrome.runtime.sendMessage({ type: 'scripts:toggle', payload: { uuid: ${JSON.stringify(alwaysUuid)}, enabled: false } })`,
    );
    expect(await waitFor(async () => ((await badge()) === '' ? 'off' : false))).toBe('off');

    await harness.extEval(
      `chrome.runtime.sendMessage({ type: 'scripts:toggle', payload: { uuid: ${JSON.stringify(alwaysUuid)}, enabled: true } })`,
    );
    await harness.reloadPage();
    await sleep(1200);
    expect(await waitFor(async () => ((await badge()) === '1' ? '1' : false))).toBe('1');
  }, 180_000);

  it('publishes one row for a command registered in five frames', async () => {
    await goto('/frames');
    expect(await harness.pageEval(`window.top === window && document.querySelectorAll('iframe').length`)).toBe(4);

    const commands = await waitFor(async () => {
      const list = await menus();
      return list.length ? list : false;
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ id: 'E2E menu', uuid: alwaysUuid, frameId: 0 });

    // A menu click still reaches the top frame.
    await harness.invokeMenu(tabId, alwaysUuid, commands[0].id);
    expect(
      await waitFor(async () =>
        (await harness.pageEval(`document.documentElement.dataset.menu`)) === 'clicked',
      ),
    ).toBe(true);

    // Reloading the framed page must not accumulate duplicates either.
    await harness.reloadPage();
    await sleep(1500);
    expect(await menus()).toHaveLength(1);
    expect(await badge()).toBe('1');
  }, 180_000);

  it('counts one run per document, not one per frame', async () => {
    await goto('/plain');
    const before = await runCount(alwaysUuid);
    await goto('/frames');
    const after = await runCount(alwaysUuid);
    // Five injections (top frame + four iframes) are still one run.
    expect(after - before).toBe(1);
  }, 180_000);
});
