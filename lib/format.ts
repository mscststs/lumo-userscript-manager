export function formatDateTime(timestamp: number | undefined, locale: string): string {
  if (!timestamp) return '—';
  try {
    return new Date(timestamp).toLocaleString(locale);
  } catch {
    return new Date(timestamp).toISOString();
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Largest unit first; the first one the distance reaches is the one shown. */
const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * DAY],
  ['month', 30 * DAY],
  ['week', 7 * DAY],
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
];

/**
 * Distance from now: "3 minutes ago" / "3 分钟前", "yesterday" / "昨天".
 *
 * Lists compare *recency*, which a relative label answers at a glance while a
 * full timestamp has to be read digit by digit. Call sites keep the absolute
 * value one hover away (`title`), so nothing is lost. `numeric: 'auto'` lets
 * the locale use its own words for the nearest steps (今天 / 昨天 / 前天).
 */
export function formatRelativeTime(
  timestamp: number | undefined,
  locale: string,
  now = Date.now(),
): string {
  if (!timestamp) return '—';
  const diff = timestamp - now;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(diff) < 45_000) return format.format(0, 'second');
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(diff) >= size || unit === 'minute') {
      return format.format(Math.round(diff / size), unit);
    }
  }
  return '—';
}

/** Local midnight of the day `timestamp` falls on. */
export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Heading for a group of entries from one calendar day: "Today", "Yesterday",
 * then the date itself ("Oct 29, Wed" / "10月29日 周三"). The year is only
 * spelled out once it differs from the current one.
 */
export function formatDayLabel(timestamp: number, locale: string, now = Date.now()): string {
  // `round`, not `floor`: a DST day is 23 or 25 hours long.
  const days = Math.round((startOfDay(timestamp) - startOfDay(now)) / DAY);
  if (days === 0 || days === -1) {
    const label = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day');
    return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
  }
  const sameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear();
  try {
    return new Intl.DateTimeFormat(locale, {
      year: sameYear ? undefined : 'numeric',
      month: 'short',
      day: 'numeric',
      weekday: 'short',
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toDateString();
  }
}

/** Wall-clock time with seconds, for entries already grouped under a day. */
export function formatClockTime(timestamp: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toLocaleTimeString();
  }
}

export function hostFromUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
