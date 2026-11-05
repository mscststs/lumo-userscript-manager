import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Chrome Web Store rejected 1.0.1 for requesting `scripting` while never
 * calling it. This suite keeps the manifest honest:
 *
 *  - every declared permission must still have a caller in the shipped code;
 *  - permissions the review flagged stay out until a feature needs them;
 *  - the built manifest, when present, matches the source list exactly.
 */

const ROOT = resolve(__dirname, '..');
const SOURCE_DIRS = ['components', 'entrypoints', 'lib', 'store', 'types'];

/** Each permission and the API surface that justifies it. */
const EVIDENCE: Record<string, RegExp[]> = {
  // `store/storage.ts` and the caches that mirror it.
  storage: [/chrome\.storage\./],
  // Script bodies, revisions and logs live in IndexedDB (`lib/db`); without
  // this permission that origin would share the small default quota.
  unlimitedStorage: [/indexedDB/],
  // Badge counts, popup tab context and `GM_openInTab`.
  tabs: [/chrome\.tabs\./],
  // The dynamic registration table for every installed userscript.
  userScripts: [/chrome\.userScripts\./],
  // Navigation commits clear and repaint the per-tab badge.
  webNavigation: [/chrome\.webNavigation/],
  // `.user.js` navigations are redirected to the installer page.
  declarativeNetRequest: [/chrome\.declarativeNetRequest/],
  // `GM_cookie`.
  cookies: [/chrome\.cookies\./],
  // `GM_download`.
  downloads: [/chrome\.downloads\./],
  // `GM_notification`.
  notifications: [/chrome\.notifications\./],
  // Background update checks.
  alarms: [/chrome\.alarms\./],
  // `GM_setClipboard` and copying the extension id from settings.
  clipboardWrite: [/\.clipboard\.(?:write|writeText)/],
};

/** Permissions the store rejected as unused; they must not come back casually. */
const REMOVED_BY_REVIEW = ['scripting', 'activeTab', 'contextMenus'];

const CONFIG = readFileSync(resolve(ROOT, 'wxt.config.ts'), 'utf8');

function extractQuoted(block: string): string[] {
  return [...block.matchAll(/'([^']+)'/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function declaredPermissions(): string[] {
  const block = CONFIG.match(/\n {4}permissions: \[([\s\S]*?)\n {4}\],/);
  if (!block) throw new Error('wxt.config.ts: permissions block not found');
  return extractQuoted(block[1] ?? '');
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...sourceFiles(full));
    } else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Read every shipped source file with whole-line comments stripped, so a
 * permission justified only by a comment ("we could call chrome.scripting")
 * does not count as a caller.
 */
function usageSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const dir of SOURCE_DIRS) {
    const root = resolve(ROOT, dir);
    if (!existsSync(root)) continue;
    for (const file of sourceFiles(root)) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
        })
        .join('\n');
      sources.set(file, code);
    }
  }
  return sources;
}

const DECLARED = declaredPermissions();
const SOURCES = usageSources();

function hasCaller(permission: string): boolean {
  const patterns = EVIDENCE[permission];
  if (!patterns) return false;
  return patterns.every((pattern) => [...SOURCES.values()].some((code) => pattern.test(code)));
}

describe('manifest permissions', () => {
  it('declares exactly the permissions that still have a caller', () => {
    // Bidirectional: a new declaration needs evidence, and stale evidence has
    // to be deleted together with the permission.
    expect([...DECLARED].sort()).toEqual([...Object.keys(EVIDENCE)].sort());

    const unused = DECLARED.filter((permission) => !hasCaller(permission));
    expect(unused, `permission(s) declared without a caller: ${unused.join(', ')}`).toEqual([]);
  });

  it('does not re-request permissions the store rejected as unused', () => {
    const reAdded = DECLARED.filter((permission) => REMOVED_BY_REVIEW.includes(permission));
    expect(reAdded, `permission(s) rejected by review: ${reAdded.join(', ')}`).toEqual([]);
  });

  it('keeps <all_urls> for the configured userscript scope', () => {
    const host = CONFIG.match(/host_permissions:\s*\[([^\]]*)\]/);
    expect(host).not.toBeNull();
    expect(extractQuoted(host?.[1] ?? '')).toContain('<all_urls>');

    // The bridge is a statically declared content script; that is why
    // `scripting` is not needed to reach pages.
    const bridge = readFileSync(resolve(ROOT, 'entrypoints/bridge.content.ts'), 'utf8');
    expect(bridge).toContain("matches: ['<all_urls>']");
  });

  const builtManifest = resolve(ROOT, '.output/chrome-mv3/manifest.json');

  it.runIf(existsSync(builtManifest))('built manifest matches this list', () => {
    const manifest = JSON.parse(readFileSync(builtManifest, 'utf8')) as {
      permissions?: string[];
    };
    expect([...(manifest.permissions ?? [])].sort()).toEqual([...DECLARED].sort());
  });
});
