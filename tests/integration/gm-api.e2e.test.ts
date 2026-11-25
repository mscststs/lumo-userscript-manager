import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canRunChromeE2E, ExtensionHarness } from './chrome-harness';

const enabled = canRunChromeE2E();

/**
 * Real-browser regression for the GM API semantics that `fetch` used to lose.
 *
 * Each assertion mirrors a bug from `docs/GM_API_AUDIT.md`: binary/FormData
 * bodies, invalid-JSON responses, value isolation, the synchronous menu id and
 * the XHR event/response properties. The page reports its results with one
 * `/echo` request so the test reads them from the fixture, not the DOM.
 *
 * Run with:
 *   npm run build
 *   LUMO_E2E=1 npm test -- tests/integration/gm-api
 */
describe.skipIf(!enabled)('GM API semantics', () => {
  const harness = new ExtensionHarness();

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('keeps XHR bodies, events and return values compatible', async () => {
    await harness.installScript(`// ==UserScript==
// @name         Lumo E2E GM semantics
// @namespace    e2e
// @version      1.0.0
// @match        ${harness.pageUrl}*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==
const origin = location.origin;
const xhr = (details) => new Promise((resolve) => GM_xmlhttpRequest({
  ...details,
  onload: (r) => resolve({ ok: true, status: r.status, text: r.responseText, response: r.response }),
  onerror: (r) => resolve({ ok: false, error: String(r.error), errorKind: r.errorKind }),
}));

(async () => {
  const results = {};

  const form = new FormData();
  form.append('field', 'value');
  const formResult = await xhr({ method: 'POST', url: origin + '/echo', data: form });
  results.form = { ok: formResult.ok, echoed: String(formResult.text).includes('field') && String(formResult.text).includes('value') };

  const buffer = new Uint8Array([104, 105]).buffer;
  const bufferResult = await xhr({ method: 'POST', url: origin + '/echo', data: buffer });
  results.binary = { ok: bufferResult.ok, echoed: String(bufferResult.text).includes('hi') };

  // redirect: "error" must only fail on an actual redirect. The request URL
  // carries the DNR marker fragment, so a naive responseURL comparison would
  // reject every request.
  const strict = await xhr({ method: 'GET', url: origin + '/', redirect: 'error' });
  results.redirectError = { ok: strict.ok, status: strict.status };

  const htmlResult = await xhr({ method: 'GET', url: origin + '/', responseType: 'json' });
  results.invalidJson = { ok: htmlResult.ok, response: htmlResult.response };

  GM_setValue('cfg', { a: 1 });
  const value = GM_getValue('cfg');
  value.a = 99;
  results.valueIsolation = GM_getValue('cfg');

  const menuId = GM_registerMenuCommand('probe', () => {});
  results.menu = { type: typeof menuId, value: String(menuId) };

  const states = [];
  const xmlResult = await new Promise((resolve) => GM_xmlhttpRequest({
    method: 'GET',
    url: origin + '/',
    onreadystatechange: (r) => states.push(r.readyState),
    onload: (r) => resolve(r),
    onerror: () => resolve(null),
  }));
  results.states = states;
  results.xml = Boolean(xmlResult && xmlResult.responseXML && xmlResult.responseXML.documentElement);

  await xhr({ method: 'POST', url: origin + '/echo', headers: { 'x-report': 'gm-semantics' }, data: JSON.stringify(results) });
})();
`);
    await harness.refresh();
    let report: string | null = null;
    for (let attempt = 0; attempt < 3 && !report; attempt += 1) {
      await harness.openPage().catch(() => undefined);
      const deadline = Date.now() + 20_000;
      while (!report && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        report = harness.echoRequests.find((r) => r.headers['x-report'] === 'gm-semantics')?.body ?? null;
      }
    }
    expect(report, 'the userscript never reported its results').not.toBeNull();
    const results = JSON.parse(report!) as Record<string, any>;

    expect(results.form).toEqual({ ok: true, echoed: true });
    expect(results.binary).toEqual({ ok: true, echoed: true });
    expect(results.redirectError).toEqual({ ok: true, status: 200 });
    // Invalid JSON must resolve like a native XHR instead of failing the request.
    expect(results.invalidJson).toEqual({ ok: true, response: null });
    expect(results.valueIsolation).toEqual({ a: 1 });
    expect(results.menu).toEqual({ type: 'string', value: 'probe' });
    expect(results.states).toContain(2);
    expect(results.states).toContain(4);
    expect(results.xml, JSON.stringify(results)).toBe(true);
  }, 120_000);
});
