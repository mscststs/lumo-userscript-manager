import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetXhrHeaderRulesForTests,
  buildXhrHeaderRule,
  prepareXhrRequest,
  splitXhrHeaders,
  xhrHeaderRuleKey,
  xhrHeaderRuleKeyFromRule,
} from '@/lib/background/xhr-header-rules';

afterEach(() => {
  __resetXhrHeaderRulesForTests();
});

describe('splitXhrHeaders', () => {
  it('keeps ordinary headers and extracts the forbidden ones', () => {
    const split = splitXhrHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      'APP-KEY': 'android64',
      'User-Agent': 'Android UA',
      Referer: 'https://space.bilibili.com/1',
      origin: 'https://space.bilibili.com',
    });
    expect(split.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
      'APP-KEY': 'android64',
    });
    expect(split.overrides).toEqual([
      { header: 'user-agent', value: 'Android UA' },
      { header: 'referer', value: 'https://space.bilibili.com/1' },
      { header: 'origin', value: 'https://space.bilibili.com' },
    ]);
  });

  it('handles missing, empty and non-string values', () => {
    expect(splitXhrHeaders(undefined)).toEqual({ headers: undefined, overrides: [] });
    expect(splitXhrHeaders({})).toEqual({ headers: undefined, overrides: [] });
    expect(splitXhrHeaders({ 'User-Agent': null, 'x-a': 1 }).headers).toEqual({ 'x-a': '1' });
  });
});

describe('buildXhrHeaderRule', () => {
  it('drops the extension Origin and Referer by default', () => {
    const rule = buildXhrHeaderRule({
      id: 100_000,
      initiator: 'extension-id',
      hostname: 'api.bilibili.com',
      overrides: [],
    });
    expect(rule.action.requestHeaders).toEqual([
      { header: 'origin', operation: 'remove' },
      { header: 'referer', operation: 'remove' },
    ]);
    expect(rule.condition).toEqual({
      initiatorDomains: ['extension-id'],
      requestDomains: ['api.bilibili.com'],
      resourceTypes: ['xmlhttprequest'],
    });
  });

  it('sends script-requested forbidden headers instead', () => {
    const rule = buildXhrHeaderRule({
      id: 100_001,
      initiator: 'extension-id',
      hostname: 'api.example.com',
      overrides: [
        { header: 'user-agent', value: 'Android UA' },
        { header: 'origin', value: 'https://example.com' },
      ],
    });
    expect(rule.action.requestHeaders).toEqual([
      { header: 'origin', operation: 'set', value: 'https://example.com' },
      { header: 'referer', operation: 'remove' },
      { header: 'user-agent', operation: 'set', value: 'Android UA' },
    ]);
  });
});

describe('rule keys', () => {
  it('are stable across ordering and case', () => {
    const a = xhrHeaderRuleKey('API.Example.com', [
      { header: 'user-agent', value: 'UA' },
      { header: 'origin', value: 'https://example.com' },
    ]);
    const b = xhrHeaderRuleKey('api.example.com', [
      { header: 'origin', value: 'https://example.com' },
      { header: 'user-agent', value: 'UA' },
    ]);
    expect(a).toBe(b);
  });

  it('round-trip through a stored rule, so a restarted worker reuses it', () => {
    const rule = buildXhrHeaderRule({
      id: 100_002,
      initiator: 'extension-id',
      hostname: 'api.bilibili.com',
      overrides: [{ header: 'user-agent', value: 'Android UA' }],
    });
    expect(xhrHeaderRuleKeyFromRule(rule)).toBe(
      xhrHeaderRuleKey('api.bilibili.com', [{ header: 'user-agent', value: 'Android UA' }]),
    );
  });

  it('ignores rules that are not ours', () => {
    const rule = buildXhrHeaderRule({
      id: 1,
      initiator: 'extension-id',
      hostname: 'api.bilibili.com',
      overrides: [],
    });
    rule.condition.resourceTypes = ['main_frame'];
    expect(xhrHeaderRuleKeyFromRule(rule)).toBeNull();
    expect(
      xhrHeaderRuleKeyFromRule({ ...rule, condition: { ...rule.condition, initiatorDomains: ['a', 'b'] } }),
    ).toBeNull();
  });
});

interface FakeRule {
  id: number;
  action: { requestHeaders: { header: string; operation: string; value?: string }[] };
  condition: { initiatorDomains?: string[]; requestDomains?: string[]; resourceTypes?: string[] };
}

function installFakeDnr() {
  const rules = new Map<number, FakeRule>();
  const updates: { removeRuleIds?: number[]; addRules?: FakeRule[] }[] = [];
  (globalThis as any).chrome = {
    runtime: { id: 'ext-id' },
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

function ruleOrigin(rule: FakeRule): string | undefined {
  return rule.action.requestHeaders.find((entry) => entry.header === 'origin')?.value;
}

describe('prepareXhrRequest', () => {
  it('returns usable headers when DNR is unavailable', async () => {
    const headers = { 'x-test': '1', 'User-Agent': 'UA' };
    const lease = await prepareXhrRequest('https://api.bilibili.com/x', headers);
    expect(lease.headers).toEqual({ 'x-test': '1' });
    expect(() => lease.release()).not.toThrow();
  });

  it('skips non-http(s) URLs', async () => {
    const data = await prepareXhrRequest('data:text/plain,hi', { 'x-a': '1' });
    expect(data.headers).toEqual({ 'x-a': '1' });
    const invalid = await prepareXhrRequest('not a url', { 'x-a': '1' });
    expect(invalid.headers).toEqual({ 'x-a': '1' });
  });
});

describe('per-host header leases', () => {
  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('installs one rule per host and shares it between identical requests', async () => {
    const { rules, updates } = installFakeDnr();
    const first = await prepareXhrRequest('https://api.example.com/a', undefined);
    const second = await prepareXhrRequest('https://api.example.com/b', undefined);
    expect(rules.size).toBe(1);
    expect(updates).toHaveLength(1);
    expect([...rules.values()][0]!.condition.requestDomains).toEqual(['api.example.com']);
    first.release();
    second.release();
    // Idle rules are kept for reuse instead of churning on every request.
    expect(rules.size).toBe(1);
  });

  it('serializes requests that need different header policies for one host', async () => {
    const { rules } = installFakeDnr();
    const first = await prepareXhrRequest('https://api.example.com/x', {
      Origin: 'https://first.example',
    });
    let secondDone = false;
    const secondPromise = prepareXhrRequest('https://api.example.com/x', {
      Origin: 'https://second.example',
    }).then((lease) => {
      secondDone = true;
      return lease;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    // The rule can only carry one policy at a time; the second request must
    // wait instead of hijacking the first one's Origin.
    expect(secondDone).toBe(false);
    expect(ruleOrigin([...rules.values()][0]!)).toBe('https://first.example');

    first.release();
    const second = await secondPromise;
    expect(secondDone).toBe(true);
    expect(rules.size).toBe(1);
    expect(ruleOrigin([...rules.values()][0]!)).toBe('https://second.example');
    second.release();
  });

  it('lets the same policy run concurrently', async () => {
    installFakeDnr();
    const first = await prepareXhrRequest('https://api.example.com/x', {
      'User-Agent': 'UA',
    });
    let secondDone = false;
    const secondPromise = prepareXhrRequest('https://api.example.com/x', {
      'User-Agent': 'UA',
    }).then((lease) => {
      secondDone = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondDone).toBe(true);
    first.release();
    (await secondPromise).release();
  });
});
