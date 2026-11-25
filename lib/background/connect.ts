import type { UserScript } from '@/types';

/**
 * `@connect` / `@match` style host authorization.
 *
 * Kept in its own module so the GM dispatcher and the network layer share one
 * implementation instead of drifting apart.
 */

export function hostMatches(entry: string, hostname: string): boolean {
  const value = entry.trim().toLowerCase();
  if (!value) return false;
  if (value === '*') return true;
  if (value.startsWith('*.')) {
    const suffix = value.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  if (value.startsWith('.')) {
    const suffix = value.slice(1);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === value || hostname.endsWith(`.${value}`);
}

export function canConnect(script: UserScript, url: string, pageUrl?: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol === 'blob:' || target.protocol === 'data:') return true;
  try {
    const pageHost = pageUrl ? new URL(pageUrl).hostname : '';
    if (pageHost && target.hostname === pageHost) return true;
    if (pageHost && (script.connect ?? []).some((entry) => entry.trim() === 'self')) {
      return target.hostname === pageHost;
    }
  } catch {
    // The page URL may be unavailable in a detached frame; fall through.
  }
  if (target.hostname === new URL(script.origin || 'https://invalid').hostname) return true;
  return (script.connect ?? []).some((entry) => hostMatches(entry, target.hostname));
}

export function requireConnect(
  script: UserScript,
  url: string,
  api: string,
  pageUrl?: string,
): void {
  if (!canConnect(script, url, pageUrl)) {
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = url;
    }
    throw new Error(
      `${api}: ${hostname} is not permitted. Add it to @connect and reinstall the script.`,
    );
  }
}
