import type { AccentColor, UISettings } from '@/types';
import { listScripts } from '@/lib/db';
import { storage } from '@/store/storage';
import { oklchToHex } from '@/lib/color';
import { ACCENTS, normalizeAccent, normalizeThemeMode } from '@/lib/theme-registry';
import { activeScriptUuids } from './matching';
import { injectedUuids } from './injected-state';

/**
 * Toolbar badge: how many scripts are actually running on the current tab.
 *
 * The number is no longer predicted from `@match` rules — it is the set of
 * scripts that reported a start in this tab (`lib/background/injected-state.ts`),
 * intersected with the scripts that are still allowed to run. That difference
 * matters for three user-visible cases:
 *
 *  - A script that failed to register (bad pattern, `userScripts` switched off)
 *    used to be counted although it never ran.
 *  - A script that only matches a frame URL used to be invisible.
 *  - A page that finished loading used to keep the count of the page before it,
 *    because Chrome clears a tab's badge when a new document commits and the
 *    old `lastText` cache believed the number was still painted.
 *
 * Counting scripts instead of reports is why frames are unioned: one script in
 * five iframes is one script.
 *
 * The set is further filtered by `activeScriptUuids` so that turning a script
 * off in the popup drops it from the badge immediately, without a reload.
 */

/** Ids of scripts that may run right now; cached until registration changes. */
let activeUuids: Set<string> | null = null;

/**
 * Last text written per tab, so repeat events (activation, focus, settings)
 * do not touch the UI. Chrome clears a tab's badge on a new document commit, so
 * this cache must be dropped whenever that happens — `forgetBadge` is wired to
 * `webNavigation.onCommitted`.
 */
const lastText = new Map<number, string>();

/**
 * Pending repaint per tab, from `requestBadgeRefresh`.
 *
 * A page load produces one injection report per frame per script; repainting on
 * each of them would read settings and intersect the sets dozens of times for a
 * single visual result. A short throttle collapses the burst.
 */
const pendingRefresh = new Map<number, ReturnType<typeof setTimeout>>();
const REFRESH_THROTTLE_MS = 50;

/**
 * Per-tab refresh ticket. Asynchronous refreshes can overlap (a commit, a
 * report, a settings write); only the newest one may paint, so an older count
 * can never overwrite a newer one.
 */
const tickets = new Map<number, number>();

/** Accent/theme signature of the palette currently applied to the badge. */
let paletteKey = '';

/** True once the badge has been cleared globally for a disabled setting. */
let suppressed = false;

/** Drop the cached active-script set; the next refresh reloads it. */
export function invalidateBadgeIndex(): void {
  activeUuids = null;
}

async function loadActiveUuids(): Promise<Set<string>> {
  if (activeUuids) return activeUuids;
  try {
    activeUuids = activeScriptUuids(await listScripts(false));
    return activeUuids;
  } catch {
    // IndexedDB unavailable: paint nothing rather than a wrong number. Do not
    // cache the empty set, so the next event retries.
    return new Set();
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
 * Count reported scripts that are still active.
 *
 * Reports come per frame but the badge counts scripts, so the input is
 * deduplicated. Pure and exported for the tests.
 */
export function countActiveInjected(
  injected: Iterable<string>,
  active: ReadonlySet<string>,
): number {
  const seen = new Set<string>();
  let count = 0;
  for (const uuid of injected) {
    if (seen.has(uuid) || !active.has(uuid)) continue;
    seen.add(uuid);
    count += 1;
  }
  return count;
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
  // Record optimistically: a failed call is retried by the next refresh, and
  // the alternative (await, then record) lets two writes interleave.
  lastText.set(tabId, text);
  try {
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // The action API is unavailable in this build; the badge is decoration, not
    // a capability, so nothing else should fail because of it.
    lastText.delete(tabId);
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

async function resolveTabId(tabId: number | undefined): Promise<number | null> {
  if (tabId !== undefined) return tabId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Recompute the badge for one tab (default: the active one).
 *
 * Called by the injection reporter (`host:run`), by navigation commits, by the
 * settings watch, and after registration changes. All of them are cheap: the
 * active-script set is cached and the count is a set intersection over a
 * handful of ids.
 */
export async function refreshBadge(tabId?: number): Promise<void> {
  try {
    const settings = await storage.getUISettings();
    if (!settings.showBadge) {
      await suppressBadges();
      return;
    }
    suppressed = false;

    const target = await resolveTabId(tabId);
    if (target === null) return;

    const ticket = (tickets.get(target) ?? 0) + 1;
    tickets.set(target, ticket);

    await applyPalette(settings);

    // The master switch pauses every script, so the honest count is zero: no
    // report can arrive while registrations are gone.
    let count = 0;
    if (settings.scriptsEnabled) {
      count = countActiveInjected(await injectedUuids(target), await loadActiveUuids());
    }

    if (tickets.get(target) !== ticket) return;
    await writeText(target, badgeTextFor(count));
  } catch (error) {
    console.warn('[Lumo Userscripts] Badge refresh failed:', error);
  }
}

/**
 * Recompute every open tab.
 *
 * Settings (badge on/off, accent) and the script set (toggle, install, delete)
 * are global, so a single active tab would leave every background tab wrong
 * until it is activated.
 */
export async function refreshAllBadges(): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(
    tabs.map((tab) => (tab.id === undefined ? undefined : refreshBadge(tab.id))),
  );
}

/**
 * Ask for a repaint soon, coalescing a burst of injection reports.
 *
 * Returns immediately: `host:run` must not wait for toolbar decoration, and the
 * count is recomputed from state anyway, so one paint per burst is enough.
 */
export function requestBadgeRefresh(tabId: number): void {
  if (pendingRefresh.has(tabId)) return;
  pendingRefresh.set(
    tabId,
    setTimeout(() => {
      pendingRefresh.delete(tabId);
      void refreshBadge(tabId);
    }, REFRESH_THROTTLE_MS),
  );
}

/** Forget per-tab bookkeeping: the tab closed, or a new document committed. */
export function forgetBadge(tabId: number): void {
  const pending = pendingRefresh.get(tabId);
  if (pending !== undefined) {
    clearTimeout(pending);
    pendingRefresh.delete(tabId);
  }
  lastText.delete(tabId);
  tickets.delete(tabId);
}
