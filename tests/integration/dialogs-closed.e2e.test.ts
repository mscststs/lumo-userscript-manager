import { afterAll, describe, expect, it } from 'vitest';
import { Cdp, ExtensionHarness } from './chrome-harness';

const enabled = process.env.LUMO_E2E === '1';

/**
 * Regression: native <dialog> is always mounted (so its close event and focus
 * return stay alive), but an author `display` rule must never make the closed
 * state visible. The URL/trash/agent dialogs used to paint on first load because
 * Tailwind `flex` overrode the UA `dialog:not([open]) { display: none }`.
 */
describe.skipIf(!enabled)('dialogs stay closed on first paint', () => {
  const harness = new ExtensionHarness();

  afterAll(async () => {
    await harness.close();
  });

  it('does not show closed dialogs on #/scripts', async () => {
    await harness.start();
    await harness.extEval(
      `chrome.tabs.create({url: chrome.runtime.getURL('options.html#/scripts')})`,
    );

    let target: any;
    for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
      target = (await harness.targets()).find((item) => item.url.includes('options.html'));
      if (!target) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(target).toBeTruthy();

    const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
    await cdp.send('Runtime.enable');
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const result = await cdp.send<{
      result: {
        value: { open: boolean; display: string; text: string }[];
      };
    }>('Runtime.evaluate', {
      expression: `([...document.querySelectorAll('dialog')].map((dialog) => ({
        open: dialog.open,
        display: getComputedStyle(dialog).display,
        text: (dialog.textContent ?? '').slice(0, 80),
      })))`,
      returnByValue: true,
    });

    const dialogs = result.result.value;
    expect(dialogs.length).toBeGreaterThan(0);
    for (const dialog of dialogs) {
      expect(dialog.open).toBe(false);
      expect(dialog.display).toBe('none');
    }
    cdp.close();
  }, 60_000);
});
