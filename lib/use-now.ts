import { useEffect, useState } from 'react';

/**
 * The current time, re-read every `intervalMs`.
 *
 * Relative labels ("3 minutes ago") are a function of *now*; without a tick
 * they freeze at whatever was true when the list rendered, which is exactly
 * the kind of silently stale state a live view must not show.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return now;
}
