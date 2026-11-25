import type { UserScript } from '@/types';
import { requireConnect } from './connect';

/**
 * `GM_cookie` implementation.
 *
 * Two details matter and are easy to get wrong:
 *   - the lookup URL must be derived from `url`, then `domain` (leading dot
 *     removed), then the page URL — otherwise `list({ domain: '.example.com' })`
 *     or `list({})` fails before the browser API is called;
 *   - HttpOnly cookies are only readable when the script explicitly asks for
 *     them, matching Violentmonkey's default.
 */

const SAME_SITE: Record<string, string> = {
  none: 'no_restriction',
  no_restriction: 'no_restriction',
  lax: 'lax',
  strict: 'strict',
  unspecified: 'unspecified',
};

function cookieLookupUrl(details: Record<string, unknown>, pageUrl?: string): string {
  const raw = details.url;
  if (typeof raw === 'string' && raw) return new URL(raw).toString();
  const domain = typeof details.domain === 'string' ? details.domain : '';
  if (domain) {
    const host = domain.replace(/^\./, '');
    if (!host) throw new Error('GM_cookie: invalid cookie domain.');
    const path = typeof details.path === 'string' && details.path ? details.path : '/';
    return new URL(`https://${host}${path.startsWith('/') ? path : `/${path}`}`).toString();
  }
  if (pageUrl) return new URL(pageUrl).toString();
  throw new Error('GM_cookie: a url, domain or page URL is required.');
}

export async function handleCookie(
  script: UserScript,
  args: unknown[],
  pageUrl?: string,
): Promise<unknown> {
  const action = String(args[0] ?? 'list');
  const details = (args[1] ?? {}) as Record<string, unknown>;
  const url = cookieLookupUrl(details, pageUrl);
  requireConnect(script, url, 'GM_cookie', pageUrl);

  switch (action) {
    case 'list': {
      const query: Record<string, unknown> = { ...details, url };
      delete query.httpOnly;
      const cookies = await chrome.cookies.getAll(query as chrome.cookies.GetAllDetails);
      return details.httpOnly === true ? cookies : cookies.filter((cookie) => !cookie.httpOnly);
    }
    case 'set': {
      const values: Record<string, unknown> = { ...details, url };
      delete values.httpOnly;
      delete values.session;
      if (values.secure === undefined) values.secure = url.startsWith('https:');
      if (typeof values.sameSite === 'string') {
        values.sameSite = SAME_SITE[values.sameSite.toLowerCase()] ?? values.sameSite;
      }
      return chrome.cookies.set(values as unknown as chrome.cookies.SetDetails);
    }
    case 'delete':
      return chrome.cookies.remove({
        name: String(details.name ?? ''),
        url,
        ...(typeof details.storeId === 'string' ? { storeId: details.storeId } : {}),
      });
    default:
      throw new Error(`Unknown GM_cookie action: ${action}`);
  }
}
