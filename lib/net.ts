import { AppError } from './errors';

/**
 * Network boundary for content that is about to become executable.
 *
 * Every URL here comes from a userscript (or from a web page that redirected a
 * `.user.js` navigation), so it is untrusted. The helper deliberately enforces
 * the same four rules everywhere:
 *
 *   1. only http(s);
 *   2. private/localhost destinations are opt-in, never the default;
 *   3. a wall-clock timeout;
 *   4. a hard byte cap enforced while streaming, before the body is buffered.
 *
 * Redirects are followed by the browser (`redirect: 'follow'`). A manual
 * redirect is not inspectable: the Fetch spec hands back an opaque-redirect
 * filtered response (status 0, empty header list), so the `Location` header and
 * the hop chain are invisible to us. Instead the landing URL reported by the
 * response is validated, and a private landing is discarded before its body is
 * buffered or executed.
 */

export interface FetchLimitedOptions {
  maxBytes: number;
  timeoutMs?: number;
  credentials?: RequestCredentials;
  /** Allow localhost/private-network targets. Only for user-typed dev URLs. */
  allowPrivate?: boolean;
  cache?: RequestCache;
  headers?: HeadersInit;
}

export interface LimitedResponse {
  text: string;
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
  status: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function parseRemoteUrl(raw: string, options: { allowPrivate?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('script.sourceRequired', undefined, `Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(
      'script.sourceRequired',
      undefined,
      `Only http(s) URLs are supported (received ${url.protocol}).`,
    );
  }
  if (!options.allowPrivate && isPrivateHost(url.hostname)) {
    throw new AppError(
      'script.privateHost',
      undefined,
      `Private-network URL is not allowed without explicit consent: ${url.hostname}`,
    );
  }
  return url;
}

/** Drop a response we are not going to read, so the request stops early. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** `hostname` of an absolute URL string; empty when it cannot be parsed. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Conservative private-address test. It intentionally covers the common
 * IPv4/IPv6 literal forms; hostnames that resolve to private addresses are the
 * DNS-rebinding case and are out of scope for a service-worker fetch guard.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    const a = octets[0]!;
    const b = octets[1]!;
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    );
  }

  if (host.includes(':')) {
    // Unique-local (fc00::/7), link-local (fe80::/10), and IPv4-mapped forms.
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
      return true;
    }
    if (host.startsWith('::ffff:')) return isPrivateHost(host.slice('::ffff:'.length));
  }

  return false;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new AppError('script.tooLarge', undefined, 'Response is larger than the allowed size.');
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError('script.tooLarge', undefined, 'Response is larger than the allowed size.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function fetchLimited(
  rawUrl: string,
  options: FetchLimitedOptions,
): Promise<LimitedResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requested = parseRemoteUrl(rawUrl, { allowPrivate: options.allowPrivate });

  const response = await fetch(requested, {
    method: 'GET',
    credentials: options.credentials ?? 'omit',
    redirect: 'follow',
    cache: options.cache ?? 'no-cache',
    headers: options.headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  // The browser followed every hop already; only the landing is observable.
  const finalUrl = response.url || requested.href;

  if (!options.allowPrivate && isPrivateHost(hostOf(finalUrl))) {
    await discard(response);
    throw new AppError(
      'script.privateHost',
      undefined,
      `Redirected to a private address: ${finalUrl}`,
    );
  }

  if (!response.ok) {
    await discard(response);
    throw new AppError(
      'update.httpError',
      { status: response.status },
      `HTTP ${response.status} for ${finalUrl}`,
    );
  }

  const bytes = await readCapped(response, options.maxBytes);
  return {
    bytes,
    text: new TextDecoder().decode(bytes),
    contentType: response.headers.get('content-type') ?? '',
    finalUrl,
    status: response.status,
  };
}
