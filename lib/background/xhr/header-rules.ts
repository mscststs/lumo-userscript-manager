import type { OffscreenXhrRequest } from '@/lib/offscreen/protocol';

/**
 * Header planning and per-request DNR rules for GM requests.
 *
 * `XMLHttpRequest.setRequestHeader` rejects forbidden header names, and the
 * browser stamps `Origin: chrome-extension://<id>` on any cross-origin POST
 * from an extension page. Both problems are solved in the network layer with a
 * `declarativeNetRequest` rule that matches exactly one request:
 *
 *   - `tabIds: [TAB_ID_NONE]` — the offscreen document is not a tab;
 *   - `urlFilter` pins the unique URL (a `#<requestId>` fragment, stripped by
 *     the browser before the request is sent, never seen by the server);
 *   - the rule is installed before the request and removed when it finishes,
 *     so concurrent requests can carry different header policies.
 *
 * Violentmonkey and ScriptCat use the same shape; a per-host rule (the previous
 * implementation) had to serialize conflicting requests and left rules behind.
 */

/** Same set as Violentmonkey's `FORBIDDEN_HEADER_RE`. */
const FORBIDDEN_EXACT = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
]);

const FORBIDDEN_PREFIX = ['proxy-', 'sec-'];

export function isForbiddenHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_EXACT.has(lower) || FORBIDDEN_PREFIX.some((prefix) => lower.startsWith(prefix));
}

export interface XhrHeaderPlan {
  /** Headers safe to hand to `XMLHttpRequest.setRequestHeader`. */
  headers: Record<string, string>;
  /** Request headers the DNR rule applies instead. */
  requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[];
  /** Response headers to strip (anonymous requests must not receive cookies). */
  responseHeaders?: chrome.declarativeNetRequest.ModifyHeaderInfo[];
  /** False when the request can be sent as-is (no rewrite needed). */
  needsRule: boolean;
}

const REMOVE = 'remove' as chrome.declarativeNetRequest.HeaderOperation;
const SET = 'set' as chrome.declarativeNetRequest.HeaderOperation;
const APPEND = 'append' as chrome.declarativeNetRequest.HeaderOperation;

/**
 * Split script headers into "browser accepts these" and "DNR must set these",
 * and add the always-on hygiene headers.
 */
export function planXhrHeaders(
  rawHeaders: unknown,
  options: { anonymous: boolean },
): XhrHeaderPlan {
  const headers: Record<string, string> = {};
  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
  const seen = new Set<string>();

  if (rawHeaders && typeof rawHeaders === 'object') {
    for (const [name, raw] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (raw === undefined || raw === null) continue;
      const value = String(raw);
      const lower = name.toLowerCase();
      if (lower === 'origin' || lower === 'referer') {
        // Let the script decide the value; the default is "remove" below.
        requestHeaders.push({ header: lower, operation: SET, value });
        seen.add(lower);
        continue;
      }
      if (isForbiddenHeader(name)) {
        requestHeaders.push({
          header: lower,
          operation: lower === 'cookie' ? APPEND : SET,
          value,
        });
        seen.add(lower);
        continue;
      }
      headers[name] = value;
    }
  }

  // A normal browser request from a page has no Origin for GET, and the
  // extension origin for POST. Neither is what userscripts expect, so the
  // default is to send none at all (Tampermonkey does the same).
  for (const header of ['origin', 'referer']) {
    if (!seen.has(header)) requestHeaders.push({ header, operation: REMOVE });
  }
  if (options.anonymous && !seen.has('cookie')) {
    requestHeaders.push({ header: 'cookie', operation: REMOVE });
  }

  return {
    headers,
    requestHeaders,
    responseHeaders: options.anonymous
      ? [{ header: 'set-cookie', operation: REMOVE }]
      : undefined,
    needsRule: requestHeaders.length > 0 || options.anonymous,
  };
}

/** DNR ids owned by XHR rules; the worker reclaims this range on startup. */
export const XHR_RULE_ID_BASE = 200_000;
export const XHR_RULE_ID_LIMIT = 1_000;

const activeRules = new Set<number>();
let nextOffset = 0;
let unavailable = false;

function requestApi(): typeof chrome.declarativeNetRequest | null {
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.declarativeNetRequest;
  return api?.updateSessionRules ? api : null;
}

function allocateId(): number | null {
  for (let attempt = 0; attempt < XHR_RULE_ID_LIMIT; attempt += 1) {
    const offset = nextOffset;
    nextOffset = (nextOffset + 1) % XHR_RULE_ID_LIMIT;
    if (!activeRules.has(XHR_RULE_ID_BASE + offset)) return XHR_RULE_ID_BASE + offset;
  }
  return null;
}

/** Append the per-request marker the DNR rule matches on. */
export function withRequestMarker(url: string, requestId: string): string {
  const hash = url.indexOf('#');
  return `${hash >= 0 ? url.slice(0, hash) : url}#${requestId}`;
}

export function stripRequestMarker(url: string): string {
  const hash = url.indexOf('#');
  return hash >= 0 ? url.slice(0, hash) : url;
}

export interface InstalledXhrRule {
  id: number;
  release: () => Promise<void>;
}

/**
 * Install the rule for one request. Returns `null` when DNR is unavailable;
 * the request then keeps the browser defaults instead of failing.
 */
export async function installXhrRule(
  originalUrl: string,
  requestUrl: string,
  plan: XhrHeaderPlan,
  options: { resourceTypes?: chrome.declarativeNetRequest.ResourceType[] } = {},
): Promise<InstalledXhrRule | null> {
  const api = requestApi();
  if (!api || unavailable || !plan.needsRule) return null;
  const id = allocateId();
  if (id === null) return null;
  const rule: chrome.declarativeNetRequest.Rule = {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: plan.requestHeaders,
      ...(plan.responseHeaders ? { responseHeaders: plan.responseHeaders } : {}),
    },
    condition: {
      tabIds: [chrome.tabs.TAB_ID_NONE],
      urlFilter: `|${requestUrl}|`,
      resourceTypes:
        options.resourceTypes ??
        (['xmlhttprequest'] as chrome.declarativeNetRequest.ResourceType[]),
    },
  };
  try {
    await api.updateSessionRules({ removeRuleIds: [id], addRules: [rule] });
  } catch (error) {
    unavailable = true;
    console.warn(
      `[Lumo Userscripts] Could not install an XHR header rule for ${new URL(originalUrl).hostname}; ` +
        'requests keep the browser defaults:',
      error,
    );
    return null;
  }
  activeRules.add(id);
  let released = false;
  return {
    id,
    release: async () => {
      if (released) return;
      released = true;
      activeRules.delete(id);
      await api.updateSessionRules({ removeRuleIds: [id] }).catch(() => undefined);
    },
  };
}

/**
 * Drop rules left behind by a previous worker instance. Requests started by
 * that worker are gone with it, so anything in our id range is orphaned.
 */
export async function reclaimXhrRules(): Promise<void> {
  const api = requestApi();
  if (!api?.getSessionRules) return;
  try {
    const rules = await api.getSessionRules();
    const orphans = rules
      .map((rule) => rule.id)
      .filter((id) => id >= XHR_RULE_ID_BASE && id < XHR_RULE_ID_BASE + XHR_RULE_ID_LIMIT);
    if (orphans.length) await api.updateSessionRules({ removeRuleIds: orphans });
  } catch (error) {
    console.warn('[Lumo Userscripts] Could not reclaim stale XHR rules:', error);
  }
}

/** Test-only reset so unit tests do not share module state. */
export function __resetXhrRulesForTests(): void {
  activeRules.clear();
  nextOffset = 0;
  unavailable = false;
}

export type { OffscreenXhrRequest };
