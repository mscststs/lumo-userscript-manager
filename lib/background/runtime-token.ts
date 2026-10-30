import type { ScriptWorld } from '@/types';
import { storage } from '@/store/storage';

/**
 * Userscript runtime tokens.
 *
 * A token proves that a request originated from a launcher the background
 * generated for a particular script and world. It is an HMAC over
 * `uuid:world` with a per-install secret, so it:
 *   - survives service-worker restarts without any session table
 *   - stays valid across script updates (open tabs keep working)
 *   - cannot be forged by a page that only knows the script UUID
 *
 * MAIN-world launchers expose their own token to the page by construction
 * (the script already runs in the page realm). USER_SCRIPT tokens never leave
 * the isolated world.
 */

const encoder = new TextEncoder();
const TOKEN_TTL_MS = 5 * 60_000;

let keyPromise: Promise<CryptoKey> | null = null;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const secret = await storage.ensureRuntimeSecret();
      return crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    })().catch((error) => {
      keyPromise = null;
      throw error;
    });
  }
  return keyPromise;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sign(uuid: string, world: ScriptWorld): Promise<string> {
  const key = await getKey();
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${uuid}:${world}`),
  );
  return base64Url(new Uint8Array(signature));
}

export async function createRuntimeToken(uuid: string, world: ScriptWorld): Promise<string> {
  const cacheKey = `${uuid}:${world}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const token = `${world}.${await sign(uuid, world)}`;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

export interface ParsedRuntimeToken {
  world: ScriptWorld;
  signature: string;
}

export function parseRuntimeToken(token: string): ParsedRuntimeToken | null {
  const separator = token.indexOf('.');
  if (separator <= 0) return null;
  const world = token.slice(0, separator);
  if (world !== 'MAIN' && world !== 'USER_SCRIPT') return null;
  const signature = token.slice(separator + 1);
  if (!signature) return null;
  return { world, signature };
}

export async function verifyRuntimeToken(token: string, uuid: string): Promise<boolean> {
  if (!token || !uuid) return false;
  const parsed = parseRuntimeToken(token);
  if (!parsed) return false;
  try {
    const expected = await sign(uuid, parsed.world);
    return constantTimeEqual(parsed.signature, expected);
  } catch {
    return false;
  }
}
