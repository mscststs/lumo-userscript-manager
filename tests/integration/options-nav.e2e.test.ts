import { afterAll, describe, expect, it } from 'vitest';
import { canRunChromeE2E, Cdp, ExtensionHarness } from './chrome-harness';

const enabled = canRunChromeE2E();

/**
 * Navigation rail collapse regression.
 *
 * Run with:
 *   npm run build
 *   LUMO_E2E=1 npm test -- tests/integration
 *
 * The label span carries both `text-optical` and `hidden`. `text-optical` sets
 * `display: inline-block`, so if that rule escapes its cascade layer it
 * outranks the `hidden` utility and the collapsed rail shows the icon plus the
 * first character of every label.
 */
describe.skipIf(!enabled)('options navigation rail', () => {
  const harness = new ExtensionHarness();

  afterAll(async () => {
    await harness.close();
  });

  it('hides labels and centres icons when collapsed', async () => {
    await harness.start();
    await harness.extEval(
      `chrome.tabs.create({url: chrome.runtime.getURL('options.html#/appearance')})`,
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
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const evaluate = async (expression: string) => {
      const result = await cdp.send<any>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return result.result.value;
    };

    const measure = () =>
      evaluate(`(() => {
        const nav = document.querySelector('nav');
        const button = nav.querySelector('button[aria-current="page"]');
        const icon = button.querySelector(':scope > span.relative.z-10');
        const label = button.querySelector(':scope > span.text-optical');
        const iconRect = icon.getBoundingClientRect();
        const labelStyle = getComputedStyle(label);
        return {
          navWidth: nav.getBoundingClientRect().width,
          iconCenter: iconRect.left + iconRect.width / 2,
          labelWidth: label.getBoundingClientRect().width,
          labelOpacity: Number(labelStyle.opacity),
        };
      })()`);

    const expanded = await measure();
    expect(expanded.navWidth).toBeGreaterThan(100);
    expect(expanded.labelWidth).toBeGreaterThan(20);
    expect(expanded.labelOpacity).toBe(1);

    await evaluate(
      `document.querySelector('nav button[aria-label="Collapse sidebar"]').click()`,
    );

    // The icon must not jump to the middle of the still-wide rail. It starts
    // left-aligned and is carried to the centre only by the width transition.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mid = await measure();
    expect(mid.iconCenter).toBeLessThan(40);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const collapsed = await measure();
    expect(collapsed.navWidth).toBe(56);
    expect(collapsed.labelWidth).toBeLessThanOrEqual(1);
    expect(collapsed.labelOpacity).toBe(0);
    expect(Math.abs(collapsed.iconCenter - collapsed.navWidth / 2)).toBeLessThanOrEqual(2);
  });
});
