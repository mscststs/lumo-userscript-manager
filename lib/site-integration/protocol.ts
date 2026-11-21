/**
 * Contract for script-site integration.
 *
 * Script sites do not know which manager is installed. Greasy Fork probes
 * `window.external.Violentmonkey.isInstalled(name, namespace)` from its own
 * script page and rewrites the install button from the answer. That probe must
 * be answered from the page world, which cannot read extension storage — so the
 * isolated side owns the opt-in state and tells the page script when to answer.
 * Keeping the two messages here (rather than in the runtime transport protocol)
 * makes the boundary obvious: nothing in this channel is an engine channel and
 * nothing in it carries a user script token.
 *
 * ## What "off" looks like
 *
 * The page script must claim the probe before the site's first paint: Greasy
 * Fork probes once and retries once, one second later, so waiting for the
 * settings round trip loses the race and the button never updates. It therefore
 * claims the name immediately and withdraws it as soon as the isolated side
 * reports "off". Until that answer arrives a page can observe that a manager
 * exists, but `isInstalled` resolves `null` — no installed name or version is
 * ever exposed while the feature is disabled.
 *
 * This module is dependency-free on purpose: it is bundled into both the
 * isolated content script and the page-world script.
 */

/** Page → isolated: "what is the current opt-in state?" */
export const SITE_STATE_REQUEST = 'lumo:site-state-request';

/** Isolated → page: the current opt-in state. */
export const SITE_STATE = 'lumo:site-state';

/** Hosts whose script pages implement the `window.external` probe. */
const SITE_HOSTS = ['greasyfork.org', 'sleazyfork.org'] as const;

/** Answer to a site's "is this installed?" probe. */
export interface SiteLookupResult {
  installed: boolean;
  /** Installed `@version`; absent when the script never declared one. */
  version?: string;
}

export interface SiteStateRequestMessage {
  __lumo: typeof SITE_STATE_REQUEST;
}

export interface SiteStateMessage {
  __lumo: typeof SITE_STATE;
  enabled: boolean;
}

export function isSiteStateRequest(value: unknown): value is SiteStateRequestMessage {
  return (value as { __lumo?: unknown } | null)?.__lumo === SITE_STATE_REQUEST;
}

export function isSiteStateMessage(value: unknown): value is SiteStateMessage {
  const data = value as { __lumo?: unknown; enabled?: unknown } | null;
  return data?.__lumo === SITE_STATE && typeof data.enabled === 'boolean';
}

/** True for `greasyfork.org` / `sleazyfork.org` and their subdomains. */
export function isSupportedSiteHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return SITE_HOSTS.some((site) => host === site || host.endsWith(`.${site}`));
}

/** Hostname of a URL, or `null` when it cannot be parsed. */
export function siteHostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Stable identity of a Greasy Fork script: its numeric id.
 *
 * Names appear in the URL (`/scripts/448434-b站评论区开盒`) and change when a
 * script is renamed, which is exactly when the `@name` in the page header no
 * longer matches the installed copy. The id survives renames, so the lookup
 * falls back to it. Both the site page (`/zh-CN/scripts/<id>-…`) and the
 * install source (`update.greasyfork.org/scripts/<id>/<name>.user.js`) use the
 * same `/scripts/<id>/` shape.
 */
export function scriptSiteKey(url: string | undefined | null): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isSupportedSiteHost(parsed.hostname)) return null;
  const match = /\/scripts\/(\d+)(?:[/-]|$)/.exec(parsed.pathname);
  return match?.[1] ? `greasyfork:${match[1]}` : null;
}

/**
 * `postMessage` target origin for the current document.
 *
 * `location.origin` is the string `"null"` for opaque origins (sandboxed
 * frames), where `postMessage` would throw. Those documents never host a
 * supported site page, but the helper must not become a crash path.
 */
export function sameOriginTarget(): string {
  return location.origin && location.origin !== 'null' ? location.origin : '*';
}
