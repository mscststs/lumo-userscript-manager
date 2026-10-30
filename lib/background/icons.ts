import type { ScriptIconCache, UserScript } from '@/types';
import {
  getScriptIcon,
  putScriptIcon,
} from '@/lib/db';

/**
 * Script identity icons.
 *
 * `@icon` points at a remote favicon. Loading it straight from the popup would
 * mean a network round trip on every open (and nothing at all offline), so the
 * background warms a small cache the first time it sees a script: install,
 * metadata save, and the first popup that asks for it. Entries hold a data URL
 * in IndexedDB — bounded (one per script, capped size) and never in
 * `chrome.storage.local`, which is reserved for small settings.
 *
 * A miss is never a blank tile: the caller gets the remote URL while the cache
 * warms and the popup paints its fallback glyph underneath, so icon loading has
 * no empty state.
 */
const MAX_BYTES = 192 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_MS = 6 * 60 * 60 * 1000;
const MAX_CONCURRENT = 3;

const inflight = new Map<string, Promise<void>>();
let active = 0;
const waiting: (() => void)[] = [];

async function withSlot(run: () => Promise<void>): Promise<void> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    await run();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/** Only http(s) sources are cacheable; `data:` is already local and `blob:` dies with its page. */
function isRemote(source: string | undefined): source is string {
  return typeof source === 'string' && /^https?:\/\//i.test(source);
}

/** The URL a surface should paint right now, cache first. */
export function iconFor(
  entry: ScriptIconCache | undefined,
  source: string | undefined,
): string | undefined {
  if (!source) return undefined;
  if (!isRemote(source)) return source;
  if (entry && entry.source === source && entry.dataUrl && Date.now() - entry.fetchedAt < MAX_AGE_MS) {
    return entry.dataUrl;
  }
  return source;
}

/** True when the cache cannot answer for this source and a fetch is warranted. */
function needsFetch(entry: ScriptIconCache | undefined, source: string | undefined): boolean {
  if (!isRemote(source)) return false;
  if (!entry || entry.source !== source) return true;
  if (entry.dataUrl) return Date.now() - entry.fetchedAt >= MAX_AGE_MS;
  return Date.now() - entry.fetchedAt >= RETRY_MS;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function download(source: string): Promise<string> {
  const response = await fetch(source, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    // Favicons are immutable in practice; the browser cache spares a second
    // request when the record is refreshed after its TTL.
    cache: 'force-cache',
  });
  if (!response.ok) throw new Error(`Icon request failed (${response.status}).`);
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!type.startsWith('image/')) throw new Error('Icon URL did not return an image.');
  const blob = await response.blob();
  if (blob.size === 0 || blob.size > MAX_BYTES) throw new Error('Icon is empty or too large.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${type};base64,${toBase64(bytes)}`;
}

/**
 * Ensure the cache holds a usable icon for `source`.
 *
 * Never throws: an unreachable or oversized icon degrades to the fallback tile,
 * and the failure is recorded so a broken URL is retried hours later rather
 * than on every popup open.
 */
export function cacheScriptIcon(uuid: string, source: string | undefined): Promise<void> {
  if (!isRemote(source)) return Promise.resolve();
  const key = `${uuid}\u0000${source}`;
  const running = inflight.get(key);
  if (running) return running;

  const job = withSlot(async () => {
    try {
      const entry = await getScriptIcon(uuid);
      if (!needsFetch(entry, source)) return;
      let dataUrl: string | undefined;
      try {
        dataUrl = await download(source);
      } catch {
        dataUrl = undefined;
      }
      const next: ScriptIconCache = {
        uuid,
        source,
        dataUrl,
        fetchedAt: Date.now(),
        failed: dataUrl === undefined,
      };
      await putScriptIcon(next);
    } catch {
      // IndexedDB unavailable (private mode, quota): the popup still paints the
      // remote URL, so there is nothing to surface here.
    }
  }).finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

/**
 * Resolve icons for a list of scripts, warming any missing entries in the
 * background. Returns display URLs (data URL or remote) keyed by uuid; callers
 * treat `undefined` as "use the fallback glyph".
 *
 * Reads are per-uuid rather than a full scan: a cached icon is a `data:` URL of
 * up to 192 KB, so reading the whole store to answer for five visible rows would
 * copy megabytes through structured-clone for nothing.
 */
export async function resolveScriptIcons(
  scripts: UserScript[],
): Promise<Map<string, string | undefined>> {
  const resolved = new Map<string, string | undefined>();
  if (scripts.length === 0) return resolved;

  const entries = await Promise.all(
    scripts.map(async (script) => {
      try {
        return await getScriptIcon(script.uuid);
      } catch {
        return undefined;
      }
    }),
  );

  scripts.forEach((script, index) => {
    const entry = entries[index];
    resolved.set(script.uuid, iconFor(entry, script.icon));
    if (needsFetch(entry, script.icon)) void cacheScriptIcon(script.uuid, script.icon);
  });
  return resolved;
}
