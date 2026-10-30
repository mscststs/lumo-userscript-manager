export function formatDateTime(timestamp: number | undefined, locale: string): string {
  if (!timestamp) return '—';
  try {
    return new Date(timestamp).toLocaleString(locale);
  } catch {
    return new Date(timestamp).toISOString();
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
