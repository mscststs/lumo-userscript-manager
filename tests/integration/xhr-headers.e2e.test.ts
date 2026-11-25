import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canRunChromeE2E, ExtensionHarness } from './chrome-harness';

const enabled = canRunChromeE2E();

/**
 * Real-browser regression for `GM_xmlhttpRequest` header repair.
 *
 * The background sends GM requests with `fetch()`, which stamps
 * `Origin: chrome-extension://<id>` on cross-origin POSTs and drops
 * `User-Agent`/`Referer`/`Origin` from `options.headers`. Some WAFs answer that
 * request shape with 412 (Bilibili does), so the DNR rule must remove the
 * extension origin and apply script-requested forbidden headers instead.
 *
 * Assertions read the fixture's request log instead of the page DOM: the
 * fixture receives the headers Chrome actually put on the wire, which is the
 * only place the repair is observable.
 *
 * Run with:
 *   npm run build
 *   LUMO_E2E=1 npm test -- tests/integration/xhr-headers
 */
describe.skipIf(!enabled)('GM_xmlhttpRequest header repair', () => {
  const harness = new ExtensionHarness();

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('hides the extension origin and applies forbidden headers', async () => {
    await harness.installScript(`// ==UserScript==
// @name         Lumo E2E XHR headers
// @namespace    e2e
// @version      1.0.0
// @match        ${harness.pageUrl}*
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==
const url = location.origin + '/echo';
GM_xmlhttpRequest({
  method: 'POST',
  url,
  headers: { 'Content-Type': 'text/plain', 'x-probe': 'plain' },
  data: 'a=1',
});
GM_xmlhttpRequest({
  method: 'POST',
  url,
  headers: {
    'Content-Type': 'text/plain',
    'x-probe': 'override',
    Origin: 'https://spoof.example',
    Referer: 'https://spoof.example/page',
    'User-Agent': 'Lumo-E2E-UA',
  },
  data: 'a=1',
});
`);
    await harness.refresh();
    // Headless Chrome occasionally leaves a freshly created tab on
    // `about:blank`; the navigation then commits on a later attempt. Retry with
    // a new tab until both requests reached the fixture. Requests may arrive in
    // any order (and can repeat across attempts), so match them by probe name.
    const probes = () => {
      const plain = harness.echoRequests.find((r) => r.headers['x-probe'] === 'plain');
      const override = harness.echoRequests.find((r) => r.headers['x-probe'] === 'override');
      return plain && override ? { plain, override } : null;
    };
    let seen = probes();
    for (let attempt = 0; attempt < 3 && !seen; attempt += 1) {
      await harness.openPage().catch(() => undefined);
      const deadline = Date.now() + 15_000;
      while (!seen && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        seen = probes();
      }
    }
    expect(seen, 'the userscript never reached the fixture').not.toBeNull();
    const { plain, override } = seen!;

    expect(plain.headers['x-probe']).toBe('plain');
    // The whole point: no `chrome-extension://` origin reaches the server.
    expect(plain.headers.origin).toBeUndefined();
    expect(plain.headers.referer).toBeUndefined();
    expect(plain.headers['user-agent']).toBeTruthy();

    expect(override.headers['x-probe']).toBe('override');
    expect(override.headers.origin).toBe('https://spoof.example');
    expect(override.headers.referer).toBe('https://spoof.example/page');
    expect(override.headers['user-agent']).toBe('Lumo-E2E-UA');
  }, 60_000);
});
