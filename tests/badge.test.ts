import { describe, expect, it } from 'vitest';
import type { UserScript } from '@/types';
import { oklchToHex } from '@/lib/color';
import { ACCENTS, normalizeAccent } from '@/lib/theme-registry';
import { badgePalette, badgeTextFor } from '@/lib/background/badge';
import { countActiveScripts, evaluateScripts } from '@/lib/background/matching';

/**
 * The badge is the only surface that reports a number the popup also reports.
 * These tests pin the two properties a user can actually notice: the count
 * agrees with the list, and it disappears instead of showing zero.
 */

function script(overrides: Partial<UserScript>): UserScript {
  return {
    uuid: crypto.randomUUID(),
    name: 'Fixture',
    namespace: '',
    version: '1.0.0',
    enabled: true,
    sort: 0,
    createdAt: 0,
    updatedAt: 0,
    runCount: 0,
    origin: '',
    checkUpdate: false,
    updateState: 'idle',
    metadata: { namespace: [''] },
    tags: [],
    grant: ['none'],
    connect: [],
    require: [],
    resource: [],
    runAt: 'document-idle',
    injectInto: 'auto',
    noFrames: false,
    unwrap: false,
    topLevelAwait: false,
    codeHash: '',
    codeSize: 0,
    ...overrides,
  };
}

function count(scripts: UserScript[], url: string | undefined): number {
  return countActiveScripts(evaluateScripts(scripts, url), url);
}

describe('badge text', () => {
  it('renders nothing for zero and clamps the width', () => {
    expect(badgeTextFor(0)).toBe('');
    expect(badgeTextFor(-1)).toBe('');
    expect(badgeTextFor(1)).toBe('1');
    expect(badgeTextFor(99)).toBe('99');
    expect(badgeTextFor(100)).toBe('99+');
  });
});

describe('active script count', () => {
  const matching = script({
    metadata: { namespace: [''], match: ['*://example.com/*'] },
  });
  const otherSite = script({
    metadata: { namespace: [''], match: ['*://other.test/*'] },
  });

  it('counts enabled, matching scripts', () => {
    expect(count([matching], 'https://example.com/page')).toBe(1);
    expect(count([matching], 'https://example.com.evil.test/page')).toBe(0);
    expect(count([matching, otherSite], 'https://example.com/page')).toBe(1);
  });

  it('ignores disabled and recycled scripts', () => {
    expect(count([script({ ...matching, enabled: false })], 'https://example.com/')).toBe(0);
    expect(count([script({ ...matching, removedAt: Date.now() })], 'https://example.com/')).toBe(0);
  });

  it('honours user overrides of the match rules', () => {
    const overridden = script({
      metadata: { namespace: [''], match: ['*://example.com/*'] },
      selfMetadata: { match: ['*://override.test/*'] },
    });
    expect(count([overridden], 'https://example.com/')).toBe(0);
    expect(count([overridden], 'https://override.test/')).toBe(1);
  });

  it('never counts on privileged pages', () => {
    expect(count([{ ...matching, metadata: { namespace: [''], match: [] } }], 'chrome://extensions')).toBe(0);
    expect(count([matching], 'chrome://extensions')).toBe(0);
    expect(count([matching], undefined)).toBe(0);
  });

  it('treats a script with no rules as matching everything', () => {
    expect(count([script({})], 'https://anything.test/')).toBe(1);
  });
});

describe('badge palette', () => {
  it('converts OKLCH to the sRGB hex the action API accepts', () => {
    // Reference values computed with the OKLab→sRGB matrices; the light azure
    // must match `--color-primary` for the default accent.
    expect(oklchToHex(0.552, 0.17, 258)).toBe('#276fd3');
    expect(oklchToHex(0.535, 0.135, 162)).toBe('#008454');
    expect(oklchToHex(1, 0, 0)).toBe('#ffffff');
    expect(oklchToHex(0, 0, 0)).toBe('#000000');
  });

  it('uses white ink on the light accent and dark ink on the bright dark-mode accent', () => {
    const light = badgePalette('azure', false);
    expect(light.text).toBe('#ffffff');
    expect(light.background).toBe('#276fd3');

    const dark = badgePalette('azure', true);
    expect(dark.background).toBe('#81b9ff');
    // Dark theme text mirrors `--color-primary-foreground` (L 0.185).
    expect(dark.text).toBe('#0f1319');
  });

  it('produces a hex colour for every accent preset', () => {
    for (const accent of Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]) {
      for (const dark of [false, true]) {
        const palette = badgePalette(accent, dark);
        expect(palette.background).toMatch(/^#[0-9a-f]{6}$/);
        expect(palette.text).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    // Unknown values fall back to the default accent instead of throwing.
    expect(badgePalette('nope' as never, false)).toEqual(badgePalette(normalizeAccent('nope'), false));
  });
});
