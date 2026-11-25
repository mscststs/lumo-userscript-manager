import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetXhrRulesForTests,
  installXhrRule,
  planXhrHeaders,
  reclaimXhrRules,
  stripRequestMarker,
  withRequestMarker,
  XHR_RULE_ID_BASE,
} from '@/lib/background/xhr/header-rules';
import { encodeXhrBody } from '@/lib/runtime/xhr-body';

interface FakeRule {
  id: number;
  action: {
    requestHeaders?: { header: string; operation: string; value?: string }[];
    responseHeaders?: { header: string; operation: string }[];
  };
  condition: { tabIds?: number[]; urlFilter?: string; resourceTypes?: string[] };
}

function installFakeDnr() {
  const rules = new Map<number, FakeRule>();
  const updates: { removeRuleIds?: number[]; addRules?: FakeRule[] }[] = [];
  (globalThis as any).chrome = {
    runtime: { id: 'ext-id' },
    tabs: { TAB_ID_NONE: -1 },
    declarativeNetRequest: {
      getSessionRules: async () => [...rules.values()],
      updateSessionRules: async (options: {
        removeRuleIds?: number[];
        addRules?: FakeRule[];
      }) => {
        updates.push(options);
        for (const id of options.removeRuleIds ?? []) rules.delete(id);
        for (const rule of options.addRules ?? []) rules.set(rule.id, rule);
      },
    },
  };
  return { rules, updates };
}

afterEach(() => {
  delete (globalThis as any).chrome;
  __resetXhrRulesForTests();
});

describe('planXhrHeaders', () => {
  it('keeps ordinary headers and moves forbidden ones to DNR', () => {
    const plan = planXhrHeaders(
      {
        'Content-Type': 'application/json',
        'APP-KEY': 'android64',
        'User-Agent': 'UA',
        Origin: 'https://example.com',
        Cookie: 'a=1',
      },
      { anonymous: false },
    );
    expect(plan.headers).toEqual({ 'Content-Type': 'application/json', 'APP-KEY': 'android64' });
    expect(plan.requestHeaders).toEqual(
      expect.arrayContaining([
        { header: 'origin', operation: 'set', value: 'https://example.com' },
        { header: 'user-agent', operation: 'set', value: 'UA' },
        { header: 'cookie', operation: 'append', value: 'a=1' },
        // `referer` was not provided, so it is removed.
        { header: 'referer', operation: 'remove' },
      ]),
    );
    expect(plan.responseHeaders).toBeUndefined();
  });

  it('drops the extension origin by default and strips cookies when anonymous', () => {
    const plan = planXhrHeaders({ 'x-test': '1' }, { anonymous: true });
    expect(plan.headers).toEqual({ 'x-test': '1' });
    expect(plan.requestHeaders).toEqual([
      { header: 'origin', operation: 'remove' },
      { header: 'referer', operation: 'remove' },
      { header: 'cookie', operation: 'remove' },
    ]);
    expect(plan.responseHeaders).toEqual([{ header: 'set-cookie', operation: 'remove' }]);
    expect(plan.needsRule).toBe(true);
  });

  it('treats sec-* and proxy-* prefixes as forbidden', () => {
    const plan = planXhrHeaders({ 'sec-ch-ua': 'x', 'proxy-authorization': 'y' }, { anonymous: false });
    expect(plan.headers).toEqual({});
    expect(plan.requestHeaders).toEqual(
      expect.arrayContaining([
        { header: 'sec-ch-ua', operation: 'set', value: 'x' },
        { header: 'proxy-authorization', operation: 'set', value: 'y' },
      ]),
    );
  });
});

describe('request markers', () => {
  it('adds and strips the fragment used to scope one DNR rule', () => {
    const url = 'https://api.example.com/x?a=1';
    const marked = withRequestMarker(url, 'req-1');
    expect(marked).toBe('https://api.example.com/x?a=1#req-1');
    expect(stripRequestMarker(marked)).toBe(url);
  });

  it('replaces an existing fragment so the marker stays unique', () => {
    expect(withRequestMarker('https://a/b#old', 'req-2')).toBe('https://a/b#req-2');
  });
});

describe('installXhrRule', () => {
  it('installs one rule per request and removes it on release', async () => {
    const { rules } = installFakeDnr();
    const plan = planXhrHeaders({ 'User-Agent': 'UA' }, { anonymous: true });
    const original = 'https://api.example.com/x';
    const requestUrl = withRequestMarker(original, 'req-9');
    const rule = await installXhrRule(original, requestUrl, plan);
    expect(rule).not.toBeNull();
    expect(rules.size).toBe(1);
    const installed = [...rules.values()][0]!;
    expect(installed.id).toBeGreaterThanOrEqual(XHR_RULE_ID_BASE);
    expect(installed.condition).toEqual({
      tabIds: [-1],
      urlFilter: `|${requestUrl}|`,
      resourceTypes: ['xmlhttprequest'],
    });
    await rule!.release();
    expect(rules.size).toBe(0);
  });

  it('supports a custom resource type (downloads)', async () => {
    const { rules } = installFakeDnr();
    const plan = planXhrHeaders({ 'x-a': '1' }, { anonymous: false });
    const rule = await installXhrRule('https://a/b', 'https://a/b#r', plan, {
      resourceTypes: ['other' as chrome.declarativeNetRequest.ResourceType],
    });
    expect([...rules.values()][0]!.condition.resourceTypes).toEqual(['other']);
    await rule!.release();
  });

  it('skips the rule when nothing needs rewriting', async () => {
    const { rules } = installFakeDnr();
    const plan = planXhrHeaders(undefined, { anonymous: false });
    // origin/referer are always removed, so a rule is still needed.
    expect(plan.needsRule).toBe(true);
    const rule = await installXhrRule('https://a/b', 'https://a/b#r', plan);
    await rule!.release();
    expect(rules.size).toBe(0);

    const noRule = planXhrHeaders(undefined, { anonymous: false });
    noRule.requestHeaders = [];
    noRule.needsRule = false;
    expect(await installXhrRule('https://a/b', 'https://a/b#r', noRule)).toBeNull();
  });

  it('reclaims orphaned rules from a previous worker', async () => {
    const { rules } = installFakeDnr();
    rules.set(XHR_RULE_ID_BASE + 3, { id: XHR_RULE_ID_BASE + 3 } as FakeRule);
    rules.set(1, { id: 1 } as FakeRule);
    await reclaimXhrRules();
    expect([...rules.keys()]).toEqual([1]);
  });
});

describe('encodeXhrBody', () => {
  it('encodes text and URLSearchParams', async () => {
    const text = await encodeXhrBody('hi');
    expect(Buffer.from(text.base64!, 'base64').toString()).toBe('hi');
    const params = await encodeXhrBody(new URLSearchParams({ a: '1' }));
    expect(Buffer.from(params.base64!, 'base64').toString()).toBe('a=1');
    expect(params.contentType).toContain('x-www-form-urlencoded');
  });

  it('encodes FormData as multipart bytes (it cannot cross the bridge as-is)', async () => {
    const form = new FormData();
    form.append('field', 'value');
    const encoded = await encodeXhrBody(form);
    expect(encoded.contentType).toContain('multipart/form-data');
    const body = Buffer.from(encoded.base64!, 'base64').toString();
    expect(body).toContain('name="field"');
    expect(body).toContain('value');
  });

  it('encodes binary payloads instead of JSON.stringify-ing them', async () => {
    const encoded = await encodeXhrBody(new Uint8Array([104, 105]).buffer);
    expect(Buffer.from(encoded.base64!, 'base64').toString()).toBe('hi');
    const blob = await encodeXhrBody(new Blob(['hello'], { type: 'text/plain' }));
    expect(Buffer.from(blob.base64!, 'base64').toString()).toBe('hello');
    expect(blob.contentType).toBe('text/plain');
  });

  it('keeps plain objects JSON encoded', async () => {
    const encoded = await encodeXhrBody({ a: 1 });
    expect(Buffer.from(encoded.base64!, 'base64').toString()).toBe('{"a":1}');
    expect(encoded.contentType).toBe('application/json');
  });
});
