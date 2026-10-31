/**
 * The options page is a singleton destination, not a document.
 *
 * Every entry point (popup rows, agent approval prompts, …) wants the same
 * thing: "show the manager at this route". Creating a tab each time leaves a
 * pile of identical managers behind and throws away the state of the one the
 * user was already using, so every open is routed through `openOptionsTab`,
 * which prefers focusing/navigating an existing options tab.
 *
 * The routing decision lives in the pure `planOptionsOpen` so it can be tested
 * without a browser; only `openOptionsTab` touches `chrome.tabs`/`chrome.windows`.
 *
 * Duplicate options tabs that already exist are *not* closed: the user may have
 * opened them deliberately, and silently closing documents is worse than a
 * stale tab. This module only stops new ones from being created.
 */

export const OPTIONS_PAGE = 'options.html';

/** Structural subset of `chrome.tabs.Tab` the planner needs. */
export interface OptionsTabLike {
  id?: number;
  url?: string;
  active?: boolean;
  windowId?: number;
  lastAccessed?: number;
}

export type OptionsOpenPlan =
  | { kind: 'focus'; tabId: number; windowId?: number }
  | { kind: 'navigate'; tabId: number; windowId?: number; url: string }
  | { kind: 'create' };

/** Absolute URL of the manager, optionally at an in-app route (`#/scripts`). */
export function optionsUrl(hash = ''): string {
  const base = chrome.runtime.getURL(OPTIONS_PAGE);
  if (!hash) return base;
  return `${base}${hash.startsWith('#') ? hash : `#${hash}`}`;
}

/**
 * Decide how to reach `targetUrl`.
 *
 * 1. A tab already on that route (or one panel deeper into it) → focus it and
 *    do nothing else, so an editor with in-progress work is never reloaded just
 *    to show the page the user is already on.
 * 2. Otherwise reuse the most recently used options tab and let it navigate.
 *    When only the fragment differs Chrome performs a same-document navigation,
 *    which the app's `hashchange` router turns into an instant route switch
 *    instead of a full reload.
 * 3. No options tab at all → create one.
 */
export function planOptionsOpen(
  tabs: OptionsTabLike[],
  baseUrl: string,
  targetUrl: string,
  lastFocusedWindowId?: number,
): OptionsOpenPlan {
  const candidates = tabs.filter(
    (tab): tab is OptionsTabLike & { id: number } =>
      tab.id !== undefined && typeof tab.url === 'string' && tab.url.startsWith(baseUrl),
  );
  if (candidates.length === 0) return { kind: 'create' };

  const exact = candidates.filter((tab) => isOnRoute(tab.url as string, targetUrl));
  const best = pickMostRecent(exact.length > 0 ? exact : candidates, lastFocusedWindowId);

  if (isOnRoute(best.url as string, targetUrl)) {
    return { kind: 'focus', tabId: best.id, windowId: best.windowId };
  }
  return { kind: 'navigate', tabId: best.id, windowId: best.windowId, url: targetUrl };
}

/**
 * `#/script/abc` is considered "on" `#/script/abc/metadata`: a deeper panel of
 * the same record still answers the request that sent the user there, and
 * navigating it back to the parent route would discard the panel they chose.
 * The separator check keeps `#/scripts` from matching `#/script`.
 */
function isOnRoute(tabUrl: string, targetUrl: string): boolean {
  return tabUrl === targetUrl || tabUrl.startsWith(`${targetUrl}/`);
}

/**
 * "Most recent" in the sense the user means it: the tab they were just looking
 * at, then the one that was active most recently, then the newest tab.
 */
function pickMostRecent<T extends OptionsTabLike & { id: number }>(
  tabs: T[],
  lastFocusedWindowId?: number,
): T {
  return tabs.reduce((best, tab) => (isMoreRecent(tab, best, lastFocusedWindowId) ? tab : best));
}

function isMoreRecent(
  a: OptionsTabLike & { id: number },
  b: OptionsTabLike & { id: number },
  lastFocusedWindowId?: number,
): boolean {
  const inFocusedWindowA = lastFocusedWindowId !== undefined && a.windowId === lastFocusedWindowId;
  const inFocusedWindowB = lastFocusedWindowId !== undefined && b.windowId === lastFocusedWindowId;
  if (inFocusedWindowA !== inFocusedWindowB) return inFocusedWindowA;
  if (Boolean(a.active) !== Boolean(b.active)) return Boolean(a.active);
  if ((a.lastAccessed ?? 0) !== (b.lastAccessed ?? 0)) {
    return (a.lastAccessed ?? 0) > (b.lastAccessed ?? 0);
  }
  return a.id > b.id;
}

/**
 * Serialized so two entry points firing at once (a popup click plus an agent
 * prompt) cannot both observe "no options tab" and create one each.
 */
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Show the manager at `hash`, reusing the options tab the user already has. */
export function openOptionsTab(hash = ''): Promise<void> {
  return serialize(async () => {
    const base = chrome.runtime.getURL(OPTIONS_PAGE);
    const target = hash ? optionsUrl(hash) : base;

    let plan: OptionsOpenPlan = { kind: 'create' };
    try {
      // `tabs.query({ url })` uses match patterns, which do not reliably cover
      // `chrome-extension://`; filtering a handful of tabs in JS is cheaper.
      const [lastFocused, tabs] = await Promise.all([
        getLastFocusedWindowId(),
        chrome.tabs.query({}),
      ]);
      plan = planOptionsOpen(tabs, base, target, lastFocused);
    } catch {
      // Showing the manager matters more than reporting a tab-query failure.
    }

    if (plan.kind !== 'create') {
      try {
        await chrome.tabs.update(
          plan.tabId,
          plan.kind === 'navigate' ? { active: true, url: plan.url } : { active: true },
        );
      } catch {
        // The tab went away between the query and the update; create instead.
        plan = { kind: 'create' };
      }
    }

    if (plan.kind === 'create') {
      await chrome.tabs.create({ url: target, active: true });
      return;
    }

    // Activating a tab in another window does not raise that window on its own.
    if (plan.windowId !== undefined) {
      await chrome.windows.update(plan.windowId, { focused: true }).catch(() => undefined);
    }
  });
}

async function getLastFocusedWindowId(): Promise<number | undefined> {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    return win.id;
  } catch {
    return undefined;
  }
}
