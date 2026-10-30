/** Loose semver comparison used for update checks. */
export function compareVersions(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : 1;
    const ls = String(l);
    const rs = String(r);
    return ls.localeCompare(rs, undefined, { numeric: true });
  }
  return 0;
}

function tokenize(version: string): (number | string)[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
