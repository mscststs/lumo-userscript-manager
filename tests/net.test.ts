import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLimited, isPrivateHost, parseRemoteUrl } from '@/lib/net';
import { AppError } from '@/lib/errors';

const originalFetch = globalThis.fetch;

/** Error code thrown by `run`, or `none` when it did not throw. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.code : 'unknown';
  }
  return 'none';
}

/** `Response.url` is a prototype getter; tests need a landing URL of their own. */
function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url, configurable: true });
  return response;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('network boundary', () => {
  it('only accepts http(s) and blocks private hosts by default', () => {
    expect(() => parseRemoteUrl('file:///etc/passwd')).toThrow(AppError);
    expect(() => parseRemoteUrl('javascript:alert(1)')).toThrow(AppError);
    expect(() => parseRemoteUrl('http://127.0.0.1/x.user.js')).toThrow(AppError);
    expect(codeOf(() => parseRemoteUrl('http://10.0.0.1/x.user.js'))).toBe('script.privateHost');
    expect(() => parseRemoteUrl('http://192.168.1.10/x.user.js')).toThrow(AppError);
    expect(() => parseRemoteUrl('https://example.com/x.user.js')).not.toThrow();
    expect(() =>
      parseRemoteUrl('http://127.0.0.1/x.user.js', { allowPrivate: true }),
    ).not.toThrow();
  });

  it('classifies common private IPv4/IPv6 forms', () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.1', '::1', 'fd00::1']) {
      expect(isPrivateHost(host)).toBe(true);
    }
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });

  it('caps a streamed response before buffering it all', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    await expect(
      fetchLimited('https://example.com/script.js', { maxBytes: 4 }),
    ).rejects.toMatchObject({ code: 'script.tooLarge' });
  });

  it('let the browser follow redirects and reports the landing URL', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        withUrl(new Response('// ==UserScript==', { status: 200 }), 'https://cdn.example.com/raw.js'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchLimited('https://github.com/u/r/raw/main/x.user.js', {
      maxBytes: 100,
    });

    // `manual` would hand back an opaque-redirect response (status 0, no
    // Location) in a real browser, which is what broke every jumping URL.
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'follow' });
    expect(result.finalUrl).toBe('https://cdn.example.com/raw.js');
    expect(result.text).toContain('==UserScript==');
  });

  it('rejects a redirect that lands on a private address', async () => {
    const fetchMock = vi.fn(async () =>
      withUrl(new Response('secret', { status: 200 }), 'http://127.0.0.1/secret'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchLimited('https://example.com/script.js', { maxBytes: 100 }),
    ).rejects.toMatchObject({ code: 'script.privateHost' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows a private landing with explicit consent', async () => {
    globalThis.fetch = vi.fn(async () =>
      withUrl(new Response('dev', { status: 200 }), 'http://192.168.1.10/dev.user.js'),
    ) as unknown as typeof fetch;

    const result = await fetchLimited('https://example.com/script.js', {
      maxBytes: 100,
      allowPrivate: true,
    });
    expect(result.text).toBe('dev');
    expect(result.finalUrl).toBe('http://192.168.1.10/dev.user.js');
  });

  it('reports the landing URL for an HTTP error and never buffers the body', async () => {
    globalThis.fetch = vi.fn(async () =>
      withUrl(new Response('nope', { status: 404 }), 'https://cdn.example.com/missing.user.js'),
    ) as unknown as typeof fetch;

    await expect(
      fetchLimited('https://example.com/script.js', { maxBytes: 100 }),
    ).rejects.toMatchObject({
      code: 'update.httpError',
      params: { status: 404 },
      detail: expect.stringContaining('https://cdn.example.com/missing.user.js'),
    });
  });
});
