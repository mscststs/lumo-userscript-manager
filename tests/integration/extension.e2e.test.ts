import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canRunChromeE2E, ExtensionHarness } from './chrome-harness';

const enabled = canRunChromeE2E();

/**
 * Real-browser regression tests for the MV3 transport.
 *
 * Run with:
 *   npm run build
 *   LUMO_E2E=1 npm test -- tests/integration
 *
 * Chrome is not available in most CI runners; the suite is skipped unless
 * `LUMO_E2E=1` is explicitly set.
 */
describe.skipIf(!enabled)('MV3 runtime integration', () => {
  const harness = new ExtensionHarness();

  let userScriptUuid = '';
  let mainScriptUuid = '';

  beforeAll(async () => {
    await harness.start();

    const match = `${harness.pageUrl}*`;
    userScriptUuid = await harness.installScript(`// ==UserScript==
// @name         Lumo E2E USER_SCRIPT
// @namespace    e2e
// @version      1.0.0
// @match        ${match}
// @inject-into  content
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @run-at       document-body
// ==/UserScript==
const current = GM_getValue('count', 0);
GM_setValue('count', current + 1);
document.documentElement.dataset.lumoUs = 'ran:' + current;
document.documentElement.dataset.lumoRemote = 'none';
GM_addValueChangeListener('count', (key, oldValue, newValue, remote) => {
  document.documentElement.dataset.lumoRemote = key + ':' + oldValue + '->' + newValue + ':remote=' + remote;
});
GM_registerMenuCommand('E2E command', () => {
  document.documentElement.dataset.lumoMenu = 'clicked';
});
`);

    mainScriptUuid = await harness.installScript(`// ==UserScript==
// @name         Lumo E2E MAIN
// @namespace    e2e
// @version      1.0.0
// @match        ${match}
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-body
// ==/UserScript==
GM_setValue('main', 1);
unsafeWindow.__lumoE2E = {
  sameWindow: unsafeWindow === window,
  value: GM_getValue('main', 0),
};
document.documentElement.dataset.lumoMain = 'ran';
`);

    await harness.refresh();
    await harness.openPage();
    try {
      await harness.waitForPage(
        `document.documentElement.dataset.lumoUs === 'ran:0' && document.documentElement.dataset.lumoMain === 'ran'`,
        20_000,
      );
    } catch (error) {
      throw new Error(
        `Scripts did not start.\n${harness.pageConsole.join('\n')}\n${String(error)}`,
      );
    }
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  }, 60_000);

  it('runs scripts in both execution worlds', async () => {
    expect(await harness.pageEval(`document.documentElement.dataset.lumoUs`)).toBe('ran:0');
    expect(await harness.pageEval(`document.documentElement.dataset.lumoMain`)).toBe('ran');
    expect(await harness.pageEval(`window.__lumoE2E`)).toEqual({
      sameWindow: true,
      value: 1,
    });
    expect(await harness.values(userScriptUuid)).toMatchObject({ count: 1 });
  });

  it('broadcasts value changes to GM_addValueChangeListener', async () => {
    await harness.setValue(userScriptUuid, 'count', 99);
    await harness.waitForPage(
      `document.documentElement.dataset.lumoRemote === 'count:1->99:remote=true'`,
      10_000,
    );
    expect(await harness.pageEval(`document.documentElement.dataset.lumoRemote`)).toBe(
      'count:1->99:remote=true',
    );
  });

  it('registers and invokes menu commands in the USER_SCRIPT world', async () => {
    const tabId = await harness.tabId();
    const commands = await harness.menuCommands(tabId);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ uuid: userScriptUuid, title: 'E2E command' });

    await harness.invokeMenu(tabId, userScriptUuid, commands[0].id);
    await harness.waitForPage(
      `document.documentElement.dataset.lumoMenu === 'clicked'`,
      10_000,
    );
  });

  it('recovers RPCs, values and menus after the worker is evicted', async () => {
    const tabId = await harness.tabId();
    expect(await harness.stopServiceWorker()).toBe(true);

    // The bridge reconnects on its own; a UI write then wakes the fresh worker.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await harness.setValue(userScriptUuid, 'count', 123);
    await harness.waitForPage(
      `document.documentElement.dataset.lumoRemote === 'count:99->123:remote=true'`,
      15_000,
    );

    // BRIDGE_RESUME makes the engine replay menu subscriptions.
    let commands: any[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      commands = await harness.menuCommands(tabId);
      if (commands.some((command) => command.uuid === userScriptUuid)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(commands.some((command) => command.uuid === userScriptUuid)).toBe(true);
  }, 60_000);

  it('registers only the engine required by the remaining world', async () => {
    await harness.purgeScript(userScriptUuid);
    await harness.refresh();

    const ids = await harness.registeredScriptIds();
    expect(ids).toContain('us-runner');
    expect(ids).not.toContain('us-host');

    await harness.reloadPage();
    await harness.waitForPage(
      `document.documentElement.dataset.lumoMain === 'ran'`,
      15_000,
    );
    expect(mainScriptUuid).toBeTruthy();
  }, 60_000);

  it('runs a script on an already-open tab via scripts:run', async () => {
    const match = `${harness.pageUrl}*`;
    const uuid = await harness.installScript(`// ==UserScript==
// @name         Lumo E2E run-on-tab
// @namespace    e2e
// @version      1.0.0
// @match        ${match}
// @grant        none
// @run-at       document-idle
// ==/UserScript==
window.__lumoRunOnTab = true;
`);
    await harness.refresh();

    const tabId = await harness.tabId();
    await harness.activateTab(tabId);
    await harness.runScript(uuid);
    await harness.waitForPage(`window.__lumoRunOnTab === true`, 15_000);
  }, 60_000);

  it('supports the original brightness-script shape: @require, regex @include, @noframes', async () => {
    const uuid = await harness.installScript(`// ==UserScript==
// @name         Lumo E2E require+noframes
// @namespace    e2e
// @version      1.0.0
// @match        ${harness.pageUrl}*
// @include      /.*127\\.0\\.0\\.1.*/
// @require      ${harness.pageUrl}require.js
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-body
// @noframes
// ==/UserScript==
document.documentElement.dataset.lumoRequire = String(window.__lumoRequireLoaded || 0);
GM_registerMenuCommand('require menu', () => {
  document.documentElement.dataset.lumoRequireMenu = 'clicked';
});
`);
    await harness.refresh();
    await harness.reloadPage();
    await harness.waitForPage(
      `document.documentElement.dataset.lumoRequire === '1' && typeof window.__lumoRequireLoaded === 'number'`,
      20_000,
    );

    const tabId = await harness.tabId();
    const commands = await harness.menuCommands(tabId);
    const command = commands.find((item) => item.uuid === uuid);
    expect(command).toBeTruthy();
    await harness.invokeMenu(tabId, uuid, command.id);
    await harness.waitForPage(
      `document.documentElement.dataset.lumoRequireMenu === 'clicked'`,
      10_000,
    );
  }, 60_000);
});
