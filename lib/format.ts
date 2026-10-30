export function formatDateTime(timestamp: number | undefined, locale: string): string {
  if (!timestamp) return '—';
  try {
    return new Date(timestamp).toLocaleString(locale);
  } catch {
    return new Date(timestamp).toISOString();
  }
}

/**
 * Date + time without seconds, for list columns.
 *
 * `toLocaleString` always includes seconds, which is the single biggest reason
 * a timestamp column has to be truncated in a dense list. Seconds matter in the
 * log stream (where entries are compared), not in "when was this script last
 * updated".
 */
export function formatDateTimeShort(timestamp: number | undefined, locale: string): string {
  if (!timestamp) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(timestamp));
  } catch {
    return formatDateTime(timestamp, locale);
  }
}

export function formatRelativeTime(timestamp: number | undefined, locale: string): string {
  if (!timestamp) return '—';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return new Date(timestamp).toLocaleTimeString(locale);
  return formatDateTime(timestamp, locale);
}

export function hostFromUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
