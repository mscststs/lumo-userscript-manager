import type { AccentColor, UISettings } from '@/types';
import { listScripts } from '@/lib/db';
import { storage } from '@/store/storage';
import { oklchToHex } from '@/lib/color';
import { ACCENTS, normalizeAccent, normalizeThemeMode } from '@/lib/theme-registry';
import {
  countActiveScripts,
  evaluateScripts,
  type EvaluatedScript,
} from './matching';

/**
 * Toolbar badge: how many scripts are actually active on the current tab.
 *
 * Two properties make this affordable enough to run on every tab event:
 *
 *  - **A compiled index, not a query.** `listScripts` + `compileUrlRules` for
 *    the whole library is cached in the worker and invalidated only when the
 *    registration changes. A navigation then costs one regex pass per script
 *    instead of an IndexedDB read plus a full metablock parse.
 *  - **Only the active tab.** Chrome badges are per-tab, so a tab that is not
 *    in front cannot be wrong for long — it is recomputed the moment it is
 *    activated. Walking every open tab on every change would be the expensive
 *    way to produce the same pixels.
 *
 * The number is defined to match the popup list: a script counts when it is
 * enabled, not in the recycle bin, and its rules match the URL. `@run-at
 * context-menu` scripts count too — they are available on the page, just not
 * on load — so the badge can never contradict the rows the user clicked.
 */

/** Index entry: only what counting needs, so the cache stays small. */
type IndexEntry = Pick<EvaluatedScript, 'active' | 'rules'>;

let index: IndexEntry[] | null = null;

/** Last text written per tab, so repeat events do not touch the UI. */
const lastText = new Map<number, string>();

/** Accent/theme signature of the palette currently applied to the badge. */
let paletteKey = '';

/** True once the badge has been cleared globally for a disabled setting. */
let suppressed = false;

/** Drop the cached library index; the next refresh recompiles it. */
export function invalidateBadgeIndex(): void {
  index = null;
}

async function loadIndex(): Promise<IndexEntry[]> {
  if (index) return index;
  try {
    const scripts = await listScripts(false);
    index = evaluateScripts(scripts, undefined).map(({ active, rules }) => ({ active, rules }));
    return index;
  } catch {
    // IndexedDB unavailable: paint nothing rather than a wrong number.
    return [];
  }
}

/**
 * Badge copy.
 *
 * Zero renders nothing at all — a permanent `0` would eat toolbar width on
 * every non-userscript page and says exactly what an empty badge says. Chrome
 * clips the text beyond ~4 characters, so large libraries report `99+`.
 */
export function badgeTextFor(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

/**
 * Accent-derived badge colours for the current appearance.
 *
 * `system` cannot be resolved here: a service worker has no `matchMedia`. It
 * falls back to the light palette, whose accent keeps ≥ 4.5:1 against white on
 * every preset, so the badge stays legible on a dark toolbar as well.
 */
export function badgePalette(
  accent: AccentColor,
  dark: boolean,
): { background: string; text: string } {
  const preset = ACCENTS[normalizeAccent(accent)];
  return dark
    ? {
        background: oklchToHex(0.78, preset.chroma * 0.78, preset.hue),
        text: oklchToHex(0.185, 0.015, preset.hue),
      }
    : {
        background: oklchToHex(preset.lightness, preset.chroma, preset.hue),
        text: '#ffffff',
      };
}

function isDarkAppearance(settings: UISettings): boolean {
  return normalizeThemeMode(settings.theme) === 'dark';
}

async function writeText(tabId: number, text: string): Promise<void> {
  if (lastText.get(tabId) === text) return;
  try {
    await chrome.action.setBadgeText({ tabId, text });
    lastText.set(tabId, text);
  } catch {
    // The action API is unavailable in this build; the badge is decoration, not
    // a capability, so nothing else should fail because of it.
  }
}

async function applyPalette(settings: UISettings): Promise<void> {
  const { background, text } = badgePalette(settings.accent, isDarkAppearance(settings));
  const key = `${background}/${text}`;
  if (key === paletteKey) return;
  paletteKey = key;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: background });
    // `setBadgeTextColor` is Chrome 110+; the project floor is 138, but the
    // optional call keeps a missing binding from throwing.
    await chrome.action.setBadgeTextColor?.({ color: text });
  } catch {
    // Palette is cosmetic; the number still renders with the browser default.
  }
}

/** Clear every tab's badge once the user turns the feature off. */
async function suppressBadges(): Promise<void> {
  if (suppressed) return;
  suppressed = true;
  lastText.clear();
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) return;
        try {
          await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
        } catch {
          // Tab closed mid-flight.
        }
      }),
    );
  } catch {
    // No tabs permission / tab list unavailable: nothing to clear.
  }
}

async function resolveTab(
  tabId: number | undefined,
  url: string | undefined,
): Promise<{ tabId: number; url: string | undefined } | null> {
  if (tabId !== undefined) {
    if (url !== undefined) return { tabId, url };
    try {
      return { tabId, url: (await chrome.tabs.get(tabId)).url };
    } catch {
      return null;
    }
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) return null;
    return { tabId: tab.id, url: tab.url };
  } catch {
    return null;
  }
}

/**
 * Recompute the badge for one tab (default: the active one).
 *
 * `url` lets navigation events hand over the URL they already have, sparing a
 * `tabs.get` on the hottest path in the worker.
 */
export async function refreshBadge(tabId?: number, url?: string): Promise<void> {
  try {
    const settings = await storage.getUISettings();
    if (!settings.showBadge) {
      await suppressBadges();
      return;
    }
    suppressed = false;

    const target = await resolveTab(tabId, url);
    if (!target) return;

    await applyPalette(settings);
    // The master switch pauses every script, so the honest count is zero even
    // though the rows still match.
    const count = settings.scriptsEnabled
      ? countActiveScripts(await loadIndex(), target.url)
      : 0;
    await writeText(target.tabId, badgeTextFor(count));
  } catch (error) {
    console.warn('[Lumo Userscripts] Badge refresh failed:', error);
  }
}

/** Forget per-tab bookkeeping for a closed tab. */
export function forgetBadge(tabId: number): void {
  lastText.delete(tabId);
}
