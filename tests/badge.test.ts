import { describe, expect, it } from 'vitest';
import type { UserScript } from '@/types';
import { oklchToHex } from '@/lib/color';
import { ACCENTS, normalizeAccent } from '@/lib/theme-registry';
import { badgePalette, badgeTextFor, countActiveInjected } from '@/lib/background/badge';
import { activeScriptUuids } from '@/lib/background/matching';
import { InjectedRegistry } from '@/lib/background/injected-state';

/**
 * The badge is the only surface that reports a number the popup also reports.
 * These tests pin the properties a user can actually notice: one script counts
 * once however many frames it entered, turning a script off removes it at once,
 * and the badge disappears instead of showing zero.
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

describe('badge text', () => {
  it('renders nothing for zero and clamps the width', () => {
    expect(badgeTextFor(0)).toBe('');
    expect(badgeTextFor(-1)).toBe('');
    expect(badgeTextFor(1)).toBe('1');
    expect(badgeTextFor(99)).toBe('99');
    expect(badgeTextFor(100)).toBe('99+');
  });
});

describe('active scripts', () => {
  it('keeps enabled scripts that are not in the recycle bin', () => {
    const enabled = script({});
    const disabled = script({ enabled: false });
    const recycled = script({ removedAt: Date.now() });
    expect([...activeScriptUuids([enabled, disabled, recycled])]).toEqual([enabled.uuid]);
  });

  it('counts a script once even when several frames reported it', () => {
    const a = 'a';
    const b = 'b';
    const active = new Set([a, b]);
    expect(countActiveInjected([a, a, b, a], active)).toBe(2);
  });

  it('drops scripts that are no longer active without a reload', () => {
    const registry = new InjectedRegistry();
    registry.note(1, 0, 'stays');
    registry.note(1, 0, 'switched-off');
    // The registry keeps what ran; the active set decides what is still valid.
    expect(countActiveInjected(registry.uuids(1), new Set(['stays']))).toBe(1);
    expect(countActiveInjected(registry.uuids(1), new Set())).toBe(0);
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
