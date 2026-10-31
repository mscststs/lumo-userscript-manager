/** Sliding-window limit for agent write calls, per calling extension. */
export const WRITE_WINDOW_MS = 60_000;
export const WRITE_LIMIT = 30;

const buckets = new Map<string, number[]>();

export function consumeWrite(senderId: string | undefined): boolean {
  const key = senderId ?? 'unknown';
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((time) => now - time < WRITE_WINDOW_MS);
  if (recent.length >= WRITE_LIMIT) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

/** Test helper: drop all counters. */
export function resetWriteLimit(): void {
  buckets.clear();
}
