/**
 * Which pages can actually receive an injected user script.
 *
 * `chrome.userScripts` match patterns only understand http(s) and file URLs
 * (plus `*`), and Chrome refuses to run extension code inside its own
 * privileged surfaces. The popup used to infer matches purely from
 * `urlMatches()`, so a script with no `@match`/`@include` (which defaults to
 * "every page") appeared active on `chrome://` tabs where nothing could ever
 * be injected.
 *
 * Keeping the rule in one pure module makes the popup, the host RPC guard and
 * the runtime launcher agree on the same definition of "injectable".
 */

export type PageAccessReason =
  | 'restricted-scheme'
  | 'protected-site'
  | 'file-access'
  | 'missing-url';

export interface PageAccess {
  injectable: boolean;
  reason?: PageAccessReason;
  /** Display label for an inaccessible page, e.g. `chrome://`. */
  label?: string;
}

/**
 * Schemes Chrome never injects extension scripts into. Firefox spellings are
 * included so the same module also describes the `-b firefox` build.
 */
const RESTRICTED_SCHEME_LABELS: Record<string, string> = {
  'chrome:': 'chrome://',
  'chrome-search:': 'chrome-search://',
  'chrome-untrusted:': 'chrome-untrusted://',
  'chrome-extension:': 'chrome-extension://',
  'edge:': 'edge://',
  'brave:': 'brave://',
  'opera:': 'opera://',
  'vivaldi:': 'vivaldi://',
  'devtools:': 'devtools://',
  'about:': 'about:',
  'view-source:': 'view-source:',
  'moz-extension:': 'moz-extension://',
  'resource:': 'resource://',
};

/** Sites Chrome explicitly protects from extension script injection. */
const PROTECTED_HOSTS = new Set(['chromewebstore.google.com']);

function isProtectedSite(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (PROTECTED_HOSTS.has(host)) return true;
  // Legacy Web Store URL: chrome.google.com/webstore/...
  return host === 'chrome.google.com' && /^\/webstore(\/|$)/i.test(url.pathname);
}

function schemeLabel(scheme: string): string {
  return RESTRICTED_SCHEME_LABELS[scheme] ?? scheme;
}

/**
 * Classify a tab URL. `file://` is reported as injectable here; the extension
 * only reaches those pages after the user grants "Allow access to file URLs",
 * which is a Chrome setting checked by the caller.
 */
export function getPageAccess(url: string | undefined): PageAccess {
  const raw = url?.trim();
  if (!raw) return { injectable: false, reason: 'missing-url' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // An unparseable URL cannot be compared against rules; keep the previous
    // behaviour (match on rules only) rather than hiding scripts arbitrarily.
    return { injectable: true };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme in RESTRICTED_SCHEME_LABELS) {
    return {
      injectable: false,
      reason: 'restricted-scheme',
      label: schemeLabel(scheme),
    };
  }

  if (isProtectedSite(parsed)) {
    return {
      injectable: false,
      reason: 'protected-site',
      label: parsed.hostname.toLowerCase(),
    };
  }

  return { injectable: true };
}

export function isInjectableUrl(url: string | undefined): boolean {
  return getPageAccess(url).injectable;
}

/** `file:///…` URLs need an explicit Chrome permission before injection. */
export function isFileUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'file:';
  } catch {
    return false;
  }
}
