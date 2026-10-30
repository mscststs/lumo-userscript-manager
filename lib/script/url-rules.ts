import type { ScriptMetadata, UrlRule } from '@/types';
import { isValidMatchPattern } from './metadata';

export interface RegistrationPatterns {
  matches: string[];
  includeGlobs: string[];
  excludeMatches: string[];
  excludeGlobs: string[];
  needsRuntimeCheck: boolean;
}

const ALL_PATTERNS = ['*://*/*', 'file:///*'];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (const char of glob) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, 'i');
}

/** Parse a Chrome match pattern into its scheme/host/path parts. */
export function parseMatchPattern(pattern: string): { scheme: string; host: string; path: string } | null {
  if (!isValidMatchPattern(pattern)) return null;
  if (pattern === '<all_urls>') return { scheme: '*', host: '*', path: '/*' };
  const match = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/);
  if (!match) return null;
  return { scheme: match[1]!, host: match[2]!, path: match[3]! };
}

export function matchPatternToRegExp(pattern: string): RegExp | null {
  const parsed = parseMatchPattern(pattern);
  if (!parsed) return null;
  const { scheme, host, path } = parsed;

  const schemeSource = scheme === '*' ? 'https?' : escapeRegExp(scheme);
  let hostSource: string;
  if (scheme === 'file') {
    hostSource = '';
  } else if (host === '*') {
    hostSource = '[^/]+';
  } else if (host.startsWith('*.')) {
    hostSource = `(?:[^/]+\\.)?${escapeRegExp(host.slice(2))}`;
  } else {
    hostSource = escapeRegExp(host);
  }

  let pathSource = '';
  for (const char of path) {
    if (char === '*') pathSource += '.*';
    else pathSource += escapeRegExp(char);
  }

  return new RegExp(`^${schemeSource}://${hostSource}${pathSource}$`, 'i');
}

function normalizeInclude(value: string): UrlRule | null {
  const raw = value.trim();
  if (!raw) return null;

  // /regex/flags
  const regexMatch = raw.match(/^\/(.+)\/([a-z]*)$/);
  if (regexMatch) {
    try {
      // Validate eagerly; an invalid regex must not be carried into the runtime.
      new RegExp(regexMatch[1]!, regexMatch[2] || 'i');
      return {
        kind: 'regex-include',
        source: regexMatch[1]!,
        flags: regexMatch[2] || 'i',
      };
    } catch {
      return null;
    }
  }

  let candidate = raw === '*' ? '*://*/*' : raw;

  // Magic TLD: https://example.tld/path -> https://example.??*/path
  if (candidate.includes('.tld/')) {
    candidate = candidate.replace(/\.tld\//g, '.??*/');
  }

  // A bare host/path is accepted by Tampermonkey as *://host/path.
  if (!candidate.includes('://')) {
    candidate = `*://${candidate.replace(/^\*\./, '*.')}`;
  }

  if (candidate.includes('://')) {
    const schemeIndex = candidate.indexOf('://');
    const rest = candidate.slice(schemeIndex + 3);
    if (!rest.includes('/')) candidate += '/*';
    let matchCandidate = candidate;
    if (matchCandidate.startsWith('*://*.')) {
      // `*://*.example.com/*` is a valid match pattern.
    } else if (matchCandidate.startsWith('*://*')) {
      // keep it
    }

    if (
      isValidMatchPattern(matchCandidate) &&
      !matchPatternHasPort(matchCandidate) &&
      !matchCandidate.includes('?') &&
      !matchCandidate.includes('[')
    ) {
      return { kind: 'match-include', pattern: matchCandidate };
    }

    // Fall back to a glob. `*` in the scheme/host/path is the same wildcard
    // users expect from @include.
    return { kind: 'glob-include', pattern: candidate };
  }

  return { kind: 'glob-include', pattern: candidate };
}

function matchPatternHasPort(pattern: string): boolean {
  const parsed = parseMatchPattern(pattern);
  return Boolean(parsed && parsed.scheme !== 'file' && parsed.host.includes(':'));
}

function normalizeExclude(value: string): UrlRule | null {
  const include = normalizeInclude(value);
  if (!include) return null;
  if (include.kind === 'match-include') return { kind: 'match-exclude', pattern: include.pattern };
  if (include.kind === 'glob-include') return { kind: 'glob-exclude', pattern: include.pattern };
  if (include.kind === 'regex-include') {
    return { kind: 'regex-exclude', source: include.source, flags: include.flags };
  }
  return null;
}

export function compileUrlRules(metadata: ScriptMetadata): UrlRule[] {
  const rules: UrlRule[] = [];

  for (const value of metadata.match ?? []) {
    const normalized = value === '*' ? '*://*/*' : value;
    if (!isValidMatchPattern(normalized)) continue;
    // Chrome match patterns do not support explicit ports. Keep the original
    // pattern as a runtime-checked glob instead of handing an invalid match to
    // chrome.userScripts.register.
    if (matchPatternHasPort(normalized)) {
      rules.push({ kind: 'glob-include', pattern: normalized });
    } else {
      rules.push({ kind: 'match-include', pattern: normalized });
    }
  }
  for (const value of metadata.include ?? []) {
    const rule = normalizeInclude(value);
    if (rule) rules.push(rule);
  }
  for (const value of metadata['exclude-match'] ?? []) {
    if (!isValidMatchPattern(value)) continue;
    if (matchPatternHasPort(value)) {
      rules.push({ kind: 'glob-exclude', pattern: value });
    } else {
      rules.push({ kind: 'match-exclude', pattern: value });
    }
  }
  for (const value of metadata.exclude ?? []) {
    const rule = normalizeExclude(value);
    if (rule) rules.push(rule);
  }

  return rules;
}

export function hasPositiveRules(rules: UrlRule[]): boolean {
  return rules.some((rule) => rule.kind.endsWith('include'));
}

export function urlMatches(url: string, rules: UrlRule[]): boolean {
  const positives = rules.filter((rule) => rule.kind.endsWith('include'));
  const negatives = rules.filter((rule) => rule.kind.endsWith('exclude'));

  for (const rule of negatives) {
    if (ruleMatches(url, rule)) return false;
  }
  if (positives.length === 0) return true;
  return positives.some((rule) => ruleMatches(url, rule));
}

function ruleMatches(url: string, rule: UrlRule): boolean {
  switch (rule.kind) {
    case 'match-include':
    case 'match-exclude': {
      const regex = matchPatternToRegExp(rule.pattern);
      return regex ? regex.test(url) : false;
    }
    case 'glob-include':
    case 'glob-exclude':
      return globToRegExp(rule.pattern).test(url);
    case 'regex-include':
    case 'regex-exclude':
      try {
        return new RegExp(rule.source, rule.flags || 'i').test(url);
      } catch {
        return false;
      }
  }
}

export function toRegistrationPatterns(rules: UrlRule[]): RegistrationPatterns {
  const matches: string[] = [];
  const includeGlobs: string[] = [];
  const excludeMatches: string[] = [];
  const excludeGlobs: string[] = [];
  let needsRuntimeCheck = false;

  for (const rule of rules) {
    switch (rule.kind) {
      case 'match-include':
        matches.push(rule.pattern);
        break;
      case 'match-exclude':
        excludeMatches.push(rule.pattern);
        break;
      case 'glob-include':
        includeGlobs.push(rule.pattern);
        break;
      case 'glob-exclude':
        excludeGlobs.push(rule.pattern);
        break;
      case 'regex-include':
      case 'regex-exclude':
        needsRuntimeCheck = true;
        break;
    }
  }

  // `chrome.userScripts` requires at least one match/includeGlob. Widen to all
  // URLs when the script only declared regex rules, then let the launcher's
  // runtime predicate narrow it down.
  if (matches.length === 0) {
    matches.push(...ALL_PATTERNS);
    needsRuntimeCheck = true;
  }

  return {
    matches: [...new Set(matches)],
    includeGlobs: [...new Set(includeGlobs)],
    excludeMatches: [...new Set(excludeMatches)],
    excludeGlobs: [...new Set(excludeGlobs)],
    needsRuntimeCheck,
  };
}

export function describeRules(rules: UrlRule[]): string[] {
  return rules.map((rule) => {
    switch (rule.kind) {
      case 'match-include':
        return `@match ${rule.pattern}`;
      case 'match-exclude':
        return `@exclude-match ${rule.pattern}`;
      case 'glob-include':
        return `@include ${rule.pattern}`;
      case 'glob-exclude':
        return `@exclude ${rule.pattern}`;
      case 'regex-include':
        return `@include /${rule.source}/${rule.flags}`;
      case 'regex-exclude':
        return `@exclude /${rule.source}/${rule.flags}`;
    }
  });
}
