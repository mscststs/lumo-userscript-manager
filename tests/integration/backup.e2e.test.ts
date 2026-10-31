import { afterAll, describe, expect, it } from 'vitest';
import { canRunChromeE2E, Cdp, ExtensionHarness } from './chrome-harness';

const enabled = canRunChromeE2E();

/**
 * Real-browser regression for the backup pipeline.
 *
 * Run with:
 *   npm run build
 *   LUMO_E2E=1 npm test -- tests/integration
 *
 * Covers what unit tests cannot: the service worker's export/import handlers,
 * conflict resolution against the live IndexedDB, and the options Data page
 * mounting without leaking a raw i18n key.
 */
describe.skipIf(!enabled)('backup restore integration', () => {
  const harness = new ExtensionHarness();

  afterAll(async () => {
    await harness.close();
  });

  it('exports, re-imports and renders the data page', async () => {
    await harness.start();
    await harness.installScript(`// ==UserScript==
// @name         Backup E2E
// @namespace    e2e
// @version      1.0.0
// @match        https://example.com/*
// ==/UserScript==
console.log('backup e2e');
`);

    const statsResponse = await harness.extEval<any>(
      `chrome.runtime.sendMessage({type:'backup:stats'})`,
    );
    expect(statsResponse.ok).toBe(true);
    expect(statsResponse.result.scripts).toBeGreaterThan(0);

    const exportResponse = await harness.extEval<any>(
      `chrome.runtime.sendMessage({type:'backup:export'})`,
    );
    expect(exportResponse.ok).toBe(true);
    const backup = JSON.stringify(exportResponse.result);

    const overwrite = await harness.extEval<any>(
      `chrome.runtime.sendMessage({type:'backup:import',payload:{data:${backup},options:{conflict:'overwrite',importSettings:false}}})`,
    );
    expect(overwrite.ok).toBe(true);
    expect(overwrite.result.imported).toBe(1);
    expect(overwrite.result.skipped).toBe(0);
    expect(overwrite.result.failed).toEqual([]);

    const skip = await harness.extEval<any>(
      `chrome.runtime.sendMessage({type:'backup:import',payload:{data:${backup},options:{conflict:'skip',importSettings:false}}})`,
    );
    expect(skip.ok).toBe(true);
    expect(skip.result.imported).toBe(0);
    expect(skip.result.skipped).toBe(1);
    expect(skip.result.failed).toEqual([]);

    await harness.extEval(
      `chrome.tabs.create({url: chrome.runtime.getURL('options.html#/settings/data')})`,
    );

    let target: any;
    for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
      const targets = await harness.targets();
      target = targets.find((item) => item.url.includes('options.html'));
      if (!target) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(target).toBeTruthy();

    const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
    await cdp.send('Runtime.enable');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const body = await cdp.send<any>('Runtime.evaluate', {
      expression: 'document.body.innerText',
      returnByValue: true,
    });
    const text = String(body.result.value);

    expect(text).toContain('EXPORT BACKUP');
    expect(text).toContain('RESTORE BACKUP');
    expect(text).toContain('ZIP backup');
    expect(text).toContain('JSON backup');
    expect(text).toContain('Drop a JSON or ZIP backup');
    // Regression guard for the raw-key bug: a missing translation renders as
    // the dotted key itself.
    expect(text).not.toMatch(/\b(settings|scripts|common)\.[a-zA-Z]/);
  });
});
