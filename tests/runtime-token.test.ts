import { beforeAll, describe, expect, it } from 'vitest';
import { createRuntimeToken, parseRuntimeToken, verifyRuntimeToken } from '@/lib/background/runtime-token';

const store = new Map<string, unknown>();

beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: store.get(key) };
        },
        async set(values: Record<string, unknown>) {
          for (const [key, value] of Object.entries(values)) store.set(key, value);
        },
      },
    },
  };
});

describe('runtime tokens', () => {
  it('creates a stable token per script and world', async () => {
    const a = await createRuntimeToken('uuid-1', 'MAIN');
    const b = await createRuntimeToken('uuid-1', 'MAIN');
    const c = await createRuntimeToken('uuid-2', 'MAIN');
    const d = await createRuntimeToken('uuid-1', 'USER_SCRIPT');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(parseRuntimeToken(a)).toMatchObject({ world: 'MAIN' });
  });

  it('verifies only the matching script and world', async () => {
    const token = await createRuntimeToken('uuid-verify', 'USER_SCRIPT');

    await expect(verifyRuntimeToken(token, 'uuid-verify')).resolves.toBe(true);
    await expect(verifyRuntimeToken(token, 'uuid-other')).resolves.toBe(false);
  });

  it('rejects malformed and tampered tokens', async () => {
    const token = await createRuntimeToken('uuid-tamper', 'MAIN');
    const [world, signature] = token.split('.');
    const flipped = `${signature?.slice(0, -1)}${signature?.endsWith('A') ? 'B' : 'A'}`;

    expect(parseRuntimeToken('')).toBeNull();
    expect(parseRuntimeToken('MAIN')).toBeNull();
    expect(parseRuntimeToken('OTHER.signature')).toBeNull();
    await expect(verifyRuntimeToken(`${world}.${flipped}`, 'uuid-tamper')).resolves.toBe(false);
  });

  it('persists the install secret', async () => {
    await createRuntimeToken('uuid-secret', 'MAIN');
    const secret = store.get('runtimeSecret');
    expect(typeof secret).toBe('string');
    expect((secret as string).length).toBeGreaterThanOrEqual(32);
  });
});
