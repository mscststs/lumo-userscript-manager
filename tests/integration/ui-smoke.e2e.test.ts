import { afterAll, describe, expect, it } from 'vitest';
import { Cdp, ExtensionHarness } from './chrome-harness';

const enabled = process.env.LUMO_E2E === '1';

describe.skipIf(!enabled)('form control smoke', () => {
  const harness = new ExtensionHarness();
  afterAll(async () => harness.close());

  it('renders select, checkbox and dialog', async () => {
    await harness.start();
    await harness.extEval(`chrome.tabs.create({url: chrome.runtime.getURL('options.html#/appearance')})`);
    let target: any;
    for (let i = 0; i < 40 && !target; i += 1) {
      target = (await harness.targets()).find((t) => t.url.includes('options.html'));
      if (!target) await new Promise((r) => setTimeout(r, 250));
    }
    expect(target).toBeTruthy();
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
    await cdp.send('Runtime.enable');
    await new Promise((r) => setTimeout(r, 1200));
    const value = async (expression: string) => {
      const result = await cdp.send<any>('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const runtime = await value(`chrome.runtime.sendMessage({type:'runtime:status'})`);
    expect(runtime?.ok).toBe(true);
    expect(runtime?.result?.userScriptsAvailable).toBe(true);

    // Select is a Radix combobox: one 32px trigger with the shared chevron, and
    // a popover panel whose options keep the `EnumValue` label/raw pairing.
    const select = await value(`(() => {
      // The sidebar search input is also a combobox; the Select trigger is a button.
      const trigger = document.querySelector('button[role="combobox"]');
      if (!trigger) return null;
      const box = trigger.getBoundingClientRect();
      const style = getComputedStyle(trigger);
      return {
        height: Math.round(box.height),
        radius: style.borderRadius,
        labelled: Boolean(trigger.getAttribute('aria-label')),
        expanded: trigger.getAttribute('aria-expanded'),
      };
    })()`);
    expect(select?.height).toBe(32);
    expect(select?.radius).toBe('8px');
    expect(select?.labelled).toBe(true);
    expect(select?.expanded).toBe('false');

    await value(`document.querySelector('button[role="combobox"]').click()`);
    await new Promise((r) => setTimeout(r, 400));
    const panel = await value(`(() => {
      // Scope to the Radix viewport: the closed language dialog keeps its own
      // listbox mounted inside a native <dialog>, so a bare [role=listbox]
      // selector would read the wrong list.
      const list = document.querySelector('[data-radix-select-viewport]');
      if (!list) return null;
      const items = [...list.querySelectorAll('[role="option"]')];
      const surface = list.closest('[data-radix-popper-content-wrapper]')?.firstElementChild;
      return {
        items: items.length,
        // The raw value is the mono, muted token next to the label.
        monoRaw: items.every((item) => Boolean(item.querySelector('.font-mono'))),
        surface: surface ? getComputedStyle(surface).boxShadow !== 'none' : false,
      };
    })()`);
    expect(panel?.items).toBeGreaterThan(1);
    expect(panel?.monoRaw).toBe(true);
    expect(panel?.surface).toBe(true);
    await value(`document.body.click()`);

    const scriptId = await harness.installScript(`// ==UserScript==\n// @name Smoke\n// @namespace smoke\n// @version 1.0.0\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\ndocument.title = 'smoke';`);
    await harness.refresh();
    let ids = await harness.registeredScriptIds();
    expect(ids).toContain(`us-${scriptId}`);
    await value(
      `chrome.runtime.sendMessage({type:'scripts:toggle',payload:{uuid:${JSON.stringify(scriptId)},enabled:false}})`,
    );
    ids = await harness.registeredScriptIds();
    expect(ids).not.toContain(`us-${scriptId}`);
    await value(
      `chrome.runtime.sendMessage({type:'scripts:toggle',payload:{uuid:${JSON.stringify(scriptId)},enabled:true}})`,
    );
    ids = await harness.registeredScriptIds();
    expect(ids).toContain(`us-${scriptId}`);

    const checkbox = await value(`(() => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.className = 'lumo-checkbox';
      el.checked = true;
      document.body.appendChild(el);
      const before = getComputedStyle(el, '::before');
      const after = getComputedStyle(el, '::after');
      const out = { before: before.backgroundColor, after: after.opacity, width: getComputedStyle(el).width };
      el.remove();
      return out;
    })()`);
    expect(checkbox.after).toBe('1');
    expect(checkbox.width).toBe('28px');

    const dialog = await value(`(() => {
      const el = document.createElement('dialog');
      el.className = 'lumo-dialog';
      document.body.appendChild(el);
      el.showModal();
      const out = { open: el.open, backdrop: getComputedStyle(el, '::backdrop').backgroundColor };
      el.close(); el.remove();
      return out;
    })()`);
    expect(dialog.open).toBe(true);
    expect(dialog.backdrop).not.toBe('rgba(0, 0, 0, 0)');
    cdp.close();
  }, 60_000);
});
