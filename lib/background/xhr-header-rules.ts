/**
 * Request-header repair for `GM_xmlhttpRequest`.
 *
 * The background runs GM requests through `fetch()`. Two Fetch-spec rules make
 * the resulting request differ from what a privileged userscript network layer
 * sends:
 *
 *   1. a cross-origin POST from the extension carries
 *      `Origin: chrome-extension://<id>`, which some WAFs reject outright
 *      (Bilibili answers 412 and never reaches the target endpoint);
 *   2. `User-Agent`, `Referer`, `Origin` and `Cookie` are forbidden header
 *      names, so values a script sets are silently dropped.
 *
 * A script that works in Tampermonkey/Greasemonkey therefore fails here even
 * though the script code is correct. `declarativeNetRequest` can rewrite those
 * headers, so each request that needs it gets a session rule scoped to
 * `initiatorDomains: [this extension]` — page-initiated requests to the same
 * host are untouched, and no extra permission is required (`<all_urls>` host
 * access already covers `modifyHeaders`).
 */

/** Headers the Fetch API refuses to set from script-created requests. */
export const PRIVILEGED_XHR_HEADERS = ['user-agent', 'referer', 'origin'] as const;

// Literal aliases keep the pure helpers testable without a `chrome` global.
const MODIFY_HEADERS = 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType;
const OPERATION_SET = 'set' as chrome.declarativeNetRequest.HeaderOperation;
const OPERATION_REMOVE = 'remove' as chrome.declarativeNetRequest.HeaderOperation;
const RESOURCE_XHR = 'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType;

export type PrivilegedXhrHeader = (typeof PRIVILEGED_XHR_HEADERS)[number];

export interface XhrHeaderOverride {
  header: PrivilegedXhrHeader;
  value: string;
}

export interface SplitXhrHeaders {
  /** Headers that can be passed to `fetch()` untouched. */
  headers: Record<string, string> | undefined;
  /** Forbidden headers, which the DNR rule has to apply instead. */
  overrides: XhrHeaderOverride[];
}

function isPrivilegedHeader(name: string): name is PrivilegedXhrHeader {
  return (PRIVILEGED_XHR_HEADERS as readonly string[]).includes(name);
}

/**
 * Split script-supplied headers into the ones `fetch()` accepts and the ones
 * only a DNR rule can send.
 *
 * `origin` and `referer` are always removed from the fetch attempt: leaving
 * `origin` in would keep the extension origin, and `referer` is ignored.
 */
export function splitXhrHeaders(headers: unknown): SplitXhrHeaders {
  if (!headers || typeof headers !== 'object') return { headers: undefined, overrides: [] };
  const kept: Record<string, string> = {};
  const found = new Map<PrivilegedXhrHeader, string>();
  for (const [name, raw] of Object.entries(headers as Record<string, unknown>)) {
    if (raw === undefined || raw === null) continue;
    const lower = name.toLowerCase();
    if (isPrivilegedHeader(lower)) {
      found.set(lower, String(raw));
      continue;
    }
    kept[name] = String(raw);
  }
  const overrides: XhrHeaderOverride[] = [];
  for (const header of PRIVILEGED_XHR_HEADERS) {
    const value = found.get(header);
    if (value !== undefined) overrides.push({ header, value });
  }
  return { headers: Object.keys(kept).length ? kept : undefined, overrides };
}

/**
 * Stable identity for a rule: the same host with the same header overrides
 * must reuse one rule, regardless of the order the script listed them in.
 */
export function xhrHeaderRuleKey(hostname: string, overrides: XhrHeaderOverride[]): string {
  const parts = overrides
    .map((entry) => `${entry.header.toLowerCase()}:${entry.value}`)
    .sort()
    .join('\n');
  return `${hostname.toLowerCase()}\n${parts}`;
}

/**
 * One rule per (host, overrides) pair. Without a script-supplied value the
 * browser-controlled header is removed; with one, the requested value is set.
 */
export function buildXhrHeaderRule(input: {
  id: number;
  initiator: string;
  hostname: string;
  overrides: XhrHeaderOverride[];
}): chrome.declarativeNetRequest.Rule {
  const requested = new Map(input.overrides.map((entry) => [entry.header, entry.value] as const));
  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
  for (const header of ['origin', 'referer'] as const) {
    const value = requested.get(header);
    requestHeaders.push(
      value === undefined
        ? {
            header,
            operation: OPERATION_REMOVE,
          }
        : {
            header,
            operation: OPERATION_SET,
            value,
          },
    );
  }
  const userAgent = requested.get('user-agent');
  if (userAgent !== undefined) {
    requestHeaders.push({
      header: 'user-agent',
      operation: OPERATION_SET,
      value: userAgent,
    });
  }

  return {
    id: input.id,
    priority: 1,
    action: {
      type: MODIFY_HEADERS,
      requestHeaders,
    },
    condition: {
      // Only requests this extension itself originates; page XHRs to the same
      // host keep their normal Origin/Referer.
      initiatorDomains: [input.initiator],
      requestDomains: [input.hostname],
      resourceTypes: [RESOURCE_XHR],
    },
  };
}

/** Rebuild a rule key from a stored rule so a worker restart can reuse it. */
export function xhrHeaderRuleKeyFromRule(
  rule: chrome.declarativeNetRequest.Rule,
): string | null {
  const hostname = rule.condition?.requestDomains?.[0];
  const initiators = rule.condition?.initiatorDomains ?? [];
  if (!hostname || initiators.length !== 1) return null;
  if (rule.condition?.resourceTypes?.length !== 1) return null;
  if (rule.condition.resourceTypes[0] !== RESOURCE_XHR) {
    return null;
  }
  const overrides: XhrHeaderOverride[] = [];
  for (const entry of rule.action?.requestHeaders ?? []) {
    if (entry.operation !== OPERATION_SET) continue;
    const header = entry.header.toLowerCase();
    if (!isPrivilegedHeader(header)) return null;
    if (typeof entry.value !== 'string') return null;
    overrides.push({ header, value: entry.value });
  }
  return xhrHeaderRuleKey(hostname, overrides);
}

/** DNR ids are per-extension; keep ours in a range the other rules avoid. */
const RULE_ID_BASE = 100_000;
const MAX_HOST_RULES = 100;

/**
 * One DNR rule per host. A host can only carry one effective header policy, so
 * requests that need a different policy are serialized: the first holder keeps
 * the rule until its response arrives, then the next policy is installed.
 * Requests that share a policy still run concurrently.
 */
interface HostSlot {
  key: string | null;
  ruleId: number | null;
  active: number;
  waiters: (() => void)[];
  queue: Promise<void>;
  usedAt: number;
}

export interface XhrRequestLease {
  /** Headers safe to pass to `fetch()`; forbidden ones are applied by DNR. */
  headers: Record<string, string> | undefined;
  /** Drop this request's claim on the host rule. Safe to call twice. */
  release: () => void;
}

const hosts = new Map<string, HostSlot>();
let reconciliation: Promise<void> | null = null;
let failures = 0;
let unavailable = false;

function dnr(): typeof chrome.declarativeNetRequest | null {
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.declarativeNetRequest;
  if (!api?.updateSessionRules || !api.getSessionRules) return null;
  return api;
}

function slotFor(hostname: string): HostSlot {
  const existing = hosts.get(hostname);
  if (existing) return existing;
  const slot: HostSlot = {
    key: null,
    ruleId: null,
    active: 0,
    waiters: [],
    queue: Promise.resolve(),
    usedAt: Date.now(),
  };
  hosts.set(hostname, slot);
  return slot;
}

function flushWaiters(slot: HostSlot): void {
  for (const resolve of slot.waiters.splice(0)) resolve();
}

function noopLease(headers: Record<string, string> | undefined): XhrRequestLease {
  return { headers, release: () => undefined };
}

/** Adopt rules a previous worker instance created before it was recycled. */
async function reclaimRules(api: typeof chrome.declarativeNetRequest): Promise<void> {
  const rules = await api.getSessionRules();
  for (const rule of rules) {
    if (rule.id < RULE_ID_BASE || rule.id >= RULE_ID_BASE + MAX_HOST_RULES) continue;
    if (rule.condition?.initiatorDomains?.[0] !== chrome.runtime.id) continue;
    const hostname = rule.condition?.requestDomains?.[0];
    const key = xhrHeaderRuleKeyFromRule(rule);
    if (!hostname || !key) continue;
    const slot = slotFor(hostname);
    if (slot.ruleId !== null) continue;
    slot.ruleId = rule.id;
    slot.key = key;
  }
}

function ready(api: typeof chrome.declarativeNetRequest): Promise<void> {
  reconciliation ??= reclaimRules(api).catch((error) => {
    console.warn('[Lumo Userscripts] Could not inspect session rules:', error);
  });
  return reconciliation;
}

function allocateId(): number | null {
  const used = new Set<number>();
  for (const slot of hosts.values()) {
    if (slot.ruleId !== null) used.add(slot.ruleId);
  }
  for (let offset = 0; offset < MAX_HOST_RULES; offset += 1) {
    const id = RULE_ID_BASE + offset;
    if (!used.has(id)) return id;
  }
  return null;
}

/** Drop an idle host so a new one fits inside the session-rule budget. */
async function evictIdleHost(api: typeof chrome.declarativeNetRequest): Promise<boolean> {
  let victim: [string, HostSlot] | null = null;
  for (const entry of hosts) {
    if (entry[1].active > 0) continue;
    if (!victim || entry[1].usedAt < victim[1].usedAt) victim = entry;
  }
  if (!victim) return false;
  const [hostname, slot] = victim;
  hosts.delete(hostname);
  if (slot.ruleId === null) return true;
  try {
    await api.updateSessionRules({ removeRuleIds: [slot.ruleId] });
  } catch (error) {
    console.warn('[Lumo Userscripts] Could not drop an obsolete header rule:', error);
  }
  return true;
}

/** Install (or replace) the single header rule that belongs to `hostname`. */
async function installRule(
  api: typeof chrome.declarativeNetRequest,
  hostname: string,
  slot: HostSlot,
  key: string,
  overrides: XhrHeaderOverride[],
): Promise<boolean> {
  let id = slot.ruleId;
  if (id === null) {
    while (hosts.size >= MAX_HOST_RULES) {
      if (!(await evictIdleHost(api))) return false;
    }
    id = allocateId();
    if (id === null) return false;
  }
  try {
    await api.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        buildXhrHeaderRule({ id, initiator: chrome.runtime.id, hostname, overrides }),
      ],
    });
  } catch (error) {
    // Missing support (older Chrome, Firefox DNR without modifyHeaders) must
    // not break the request itself; after a few failures stop paying for it.
    failures += 1;
    if (failures >= 3) unavailable = true;
    if (failures === 1) {
      console.warn(
        '[Lumo Userscripts] Header rules are unavailable; GM requests keep browser defaults:',
        error,
      );
    }
    return false;
  }
  failures = 0;
  slot.ruleId = id;
  slot.key = key;
  return true;
}

/**
 * Claim a header policy for one request.
 *
 * Resolves with a lease only once the matching rule is on disk, so the caller
 * can release it as soon as the response headers arrive. When another request
 * to the same host currently holds a different policy, this waits: a DNR rule
 * cannot distinguish two requests to the same URL, and letting both rules
 * match would leak one script's `Origin`/`User-Agent` into the other.
 */
async function acquire(
  hostname: string,
  overrides: XhrHeaderOverride[],
): Promise<XhrRequestLease | null> {
  const api = dnr();
  if (!api || unavailable) return null;
  await ready(api);
  const key = xhrHeaderRuleKey(hostname, overrides);
  const slot = slotFor(hostname);
  slot.usedAt = Date.now();
  let leased = false;
  const task = slot.queue.then(async () => {
    while (slot.active > 0 && slot.key !== key) {
      await new Promise<void>((resolve) => slot.waiters.push(resolve));
    }
    if (slot.ruleId === null || slot.key !== key) {
      if (!(await installRule(api, hostname, slot, key, overrides))) return;
    }
    slot.active += 1;
    leased = true;
  });
  slot.queue = task.catch(() => undefined);
  await task.catch(() => undefined);
  if (!leased) return null;
  let released = false;
  return {
    headers: undefined,
    release: () => {
      if (released) return;
      released = true;
      slot.active = Math.max(0, slot.active - 1);
      slot.usedAt = Date.now();
      if (slot.active === 0) flushWaiters(slot);
    },
  };
}

/**
 * Prepare headers for a GM request and install the matching DNR rule.
 *
 * Rule failures never fail the request: a request without header repair still
 * works for the many hosts that do not care about Origin.
 */
export async function prepareXhrRequest(
  url: string,
  headers: unknown,
): Promise<XhrRequestLease> {
  const { headers: kept, overrides } = splitXhrHeaders(headers);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return noopLease(kept);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return noopLease(kept);
  let lease: XhrRequestLease | null = null;
  try {
    lease = await acquire(parsed.hostname, overrides);
  } catch {
    lease = null;
  }
  if (!lease) return noopLease(kept);
  return {
    headers: kept,
    release: lease.release,
  };
}

/** Test-only reset so unit tests do not share module state. */
export function __resetXhrHeaderRulesForTests(): void {
  for (const slot of hosts.values()) flushWaiters(slot);
  hosts.clear();
  reconciliation = null;
  failures = 0;
  unavailable = false;
}
