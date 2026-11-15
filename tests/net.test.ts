import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLimited, isPrivateHost, parseRemoteUrl } from '@/lib/net';
import { AppError } from '@/lib/errors';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('network boundary', () => {
  it('only accepts http(s) and blocks private hosts by default', () => {
    expect(() => parseRemoteUrl('file:///etc/passwd')).toThrow(AppError);
    expect(() => parseRemoteUrl('javascript:alert(1)')).toThrow(AppError);
    expect(() => parseRemoteUrl('http://127.0.0.1/x.user.js')).toThrow(AppError);
    expect(() => parseRemoteUrl('http://10.0.0.1/x.user.js')).toThrow(AppError);
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

  it('revalidates redirect hops instead of following blindly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchLimited('https://example.com/script.js', { maxBytes: 100 }),
    ).rejects.toBeInstanceOf(AppError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
