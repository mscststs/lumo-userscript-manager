/**
 * Which scripts actually started, per tab and per frame.
 *
 * The toolbar badge used to be a *prediction*: "enabled scripts whose rules
 * match this URL". That number can be wrong in both directions — a script that
 * failed to register was still counted, and a frame-only script was invisible —
 * and it had no way to notice that the browser clears a tab's badge whenever a
 * new document commits. The badge is therefore driven by reports from the
 * runtime now: the engine tells us a script started (`host:run`), and this
 * module is the single place that remembers it.
 *
 * ## Why frames
 *
 * A registered userscript runs in *every* matching frame (`allFrames`), so one
 * script produces one report per frame. The badge counts scripts, not reports:
 * `uuids()` unions the frames and a script appears once no matter how many
 * iframes it entered.
 *
 * ## Why document ids
 *
 * Reports travel over two hops (page → content script → worker) and can land
 * after the frame has already navigated. Every report carries the sender's
 * `documentId`, and every frame records the document it belongs to, so a late
 * report from the previous document is dropped instead of repopulating a badge
 * that was just cleared. When the id is unavailable the report is still
 * accepted — a stale count for a few milliseconds is better than no count.
 *
 * ## Why session storage
 *
 * The MV3 worker is evicted all the time; the documents it was reporting on are
 * not. The state is mirrored into `chrome.storage.session` (a few hundred bytes,
 * bounded by tabs × frames × scripts) so a respawned worker does not report zero
 * for a page that is still running scripts. Nothing here is persisted to disk.
 */

export interface FrameReport {
  /** Chrome document id of the frame's document, when the sender provides one. */
  documentId?: string;
  /** Frame URL at report time; kept for diagnostics only. */
  url?: string;
}

export interface FrameInjection {
  documentId?: string;
  url: string;
  /** Script uuids that reported a start in this document of this frame. */
  scripts: string[];
}

export type InjectedSnapshot = Record<string, Record<string, FrameInjection>>;

/** Pure, synchronous bookkeeping. The module singleton below adds persistence. */
export class InjectedRegistry {
  private readonly tabs = new Map<number, Map<number, FrameInjection>>();

  /** Forget a tab (top-level document committed, or tab closed). */
  resetTab(tabId: number, report: FrameReport = {}): boolean {
    const had = this.tabs.delete(tabId);
    // Seed the top frame with the new document id so an in-flight report from
    // the old document is recognisable as stale.
    this.tabs.set(tabId, new Map([[0, toFrame(report)]]));
    return had;
  }

  /** Forget one frame (sub-frame document committed). */
  resetFrame(tabId: number, frameId: number, report: FrameReport = {}): boolean {
    const frames = this.tabs.get(tabId);
    if (!frames) return false;
    const frame = toFrame(report);
    if (frameId === 0) {
      frames.clear();
      frames.set(0, frame);
      return true;
    }
    const had = frames.get(frameId)?.scripts.length ?? 0;
    frames.set(frameId, frame);
    return had > 0;
  }

  /**
   * Record that `uuid` started in `frameId`.
   *
   * Returns true only for the first report of that script in this tab, which is
   * what "a script ran on this page" means — one run per document, not one per
   * frame.
   */
  note(tabId: number, frameId: number, uuid: string, report: FrameReport = {}): boolean {
    if (!uuid) return false;
    const frames = this.tabs.get(tabId) ?? new Map<number, FrameInjection>();
    if (!this.tabs.has(tabId)) this.tabs.set(tabId, frames);

    let frame = frames.get(frameId);
    if (frame && report.documentId && frame.documentId && frame.documentId !== report.documentId) {
      // A report from a document this frame has already navigated away from.
      return false;
    }
    if (!frame) {
      frame = toFrame(report);
      frames.set(frameId, frame);
    } else {
      if (!frame.documentId && report.documentId) frame.documentId = report.documentId;
      if (report.url) frame.url = report.url;
    }

    const had = this.has(tabId, uuid);
    if (!frame.scripts.includes(uuid)) frame.scripts.push(uuid);
    return !had;
  }

  has(tabId: number, uuid: string): boolean {
    const frames = this.tabs.get(tabId);
    if (!frames) return false;
    for (const frame of frames.values()) if (frame.scripts.includes(uuid)) return true;
    return false;
  }

  /** Scripts reported in any frame of `tabId`, first-seen order, deduplicated. */
  uuids(tabId: number): string[] {
    const frames = this.tabs.get(tabId);
    if (!frames) return [];
    const seen = new Set<string>();
    for (const frame of frames.values()) {
      for (const uuid of frame.scripts) seen.add(uuid);
    }
    return [...seen];
  }

  forget(tabId: number): boolean {
    return this.tabs.delete(tabId);
  }

  /**
   * Drop one script from every tab. Called when it is switched off or recycled:
   * switching it back on must not resurrect a count for a document that never
   * ran it — that needs a reload, exactly like the injection itself.
   */
  forgetScript(uuid: string): boolean {
    let changed = false;
    for (const frames of this.tabs.values()) {
      for (const frame of frames.values()) {
        const index = frame.scripts.indexOf(uuid);
        if (index < 0) continue;
        frame.scripts.splice(index, 1);
        changed = true;
      }
    }
    return changed;
  }

  tabIds(): number[] {
    return [...this.tabs.keys()];
  }

  /** Serializable mirror for `chrome.storage.session`; empty frames are dropped. */
  snapshot(): InjectedSnapshot {
    const snapshot: InjectedSnapshot = {};
    for (const [tabId, frames] of this.tabs) {
      const entry: Record<string, FrameInjection> = {};
      for (const [frameId, frame] of frames) {
        if (frame.scripts.length === 0) continue;
        entry[String(frameId)] = {
          documentId: frame.documentId,
          url: frame.url,
          scripts: [...frame.scripts],
        };
      }
      if (Object.keys(entry).length) snapshot[String(tabId)] = entry;
    }
    return snapshot;
  }

  /** Restore a snapshot defensively; session storage may hold a stale shape. */
  restore(value: unknown): void {
    this.tabs.clear();
    if (!value || typeof value !== 'object') return;
    for (const [rawTabId, rawFrames] of Object.entries(value as Record<string, unknown>)) {
      const tabId = Number(rawTabId);
      if (!Number.isInteger(tabId) || !rawFrames || typeof rawFrames !== 'object') continue;
      const frames = new Map<number, FrameInjection>();
      for (const [rawFrameId, rawFrame] of Object.entries(rawFrames as Record<string, unknown>)) {
        const frameId = Number(rawFrameId);
        const item = rawFrame as Partial<FrameInjection> | null;
        if (!Number.isInteger(frameId) || !Array.isArray(item?.scripts)) continue;
        const scripts = item.scripts.filter(
          (uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0,
        );
        frames.set(frameId, {
          documentId: typeof item.documentId === 'string' ? item.documentId : undefined,
          url: typeof item.url === 'string' ? item.url : '',
          scripts,
        });
      }
      if (frames.size) this.tabs.set(tabId, frames);
    }
  }
}

function toFrame(report: FrameReport): FrameInjection {
  return { documentId: report.documentId, url: report.url ?? '', scripts: [] };
}

// ---------------------------------------------------------------------------
// Shared instance + session-storage mirror
// ---------------------------------------------------------------------------

const SESSION_KEY = 'injectedFrames';

export const injectedRegistry = new InjectedRegistry();

let hydration: Promise<void> | null = null;
let hydrated = false;
let persistQueued = false;

function sessionArea(): chrome.storage.StorageArea | undefined {
  try {
    return chrome.storage?.session;
  } catch {
    return undefined;
  }
}

/**
 * Session storage is per browser session and survives worker restarts. Closed
 * tabs never send `onRemoved` to a dead worker, so prune them on the way in.
 */
async function pruneClosedTabs(): Promise<void> {
  let open: Set<number>;
  try {
    const tabs = await chrome.tabs.query({});
    open = new Set(tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
  } catch {
    return;
  }
  let changed = false;
  for (const tabId of injectedRegistry.tabIds()) {
    if (!open.has(tabId) && injectedRegistry.forget(tabId)) changed = true;
  }
  if (changed) persist();
}

export function hydrateInjectedState(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    const area = sessionArea();
    if (!area) {
      hydrated = true;
      return;
    }
    try {
      const stored = await area.get(SESSION_KEY);
      injectedRegistry.restore(stored?.[SESSION_KEY]);
    } catch {
      // Storage unavailable: start empty rather than serving a stale count.
    }
    hydrated = true;
    await pruneClosedTabs();
  })();
  return hydration;
}

/**
 * Mirror the registry into session storage.
 *
 * The write is coalesced to the end of the current task: a navigation produces
 * one report per frame per script and they usually arrive together. A microtask
 * always runs before the worker can be suspended, so nothing is lost.
 */
function persist(): void {
  if (!hydrated || persistQueued) return;
  persistQueued = true;
  queueMicrotask(() => {
    persistQueued = false;
    const area = sessionArea();
    if (!area) return;
    void area.set({ [SESSION_KEY]: injectedRegistry.snapshot() }).catch(() => undefined);
  });
}

export async function resetTabInjectedState(tabId: number, report: FrameReport = {}): Promise<void> {
  await hydrateInjectedState();
  injectedRegistry.resetTab(tabId, report);
  persist();
}

export async function resetFrameInjectedState(
  tabId: number,
  frameId: number,
  report: FrameReport = {},
): Promise<void> {
  await hydrateInjectedState();
  if (injectedRegistry.resetFrame(tabId, frameId, report)) persist();
}

/** Report a running script. Returns true only for its first report in this tab. */
export async function noteInjection(
  tabId: number,
  frameId: number,
  uuid: string,
  report: FrameReport = {},
): Promise<boolean> {
  await hydrateInjectedState();
  const first = injectedRegistry.note(tabId, frameId, uuid, report);
  persist();
  return first;
}

export async function injectedUuids(tabId: number): Promise<string[]> {
  await hydrateInjectedState();
  return injectedRegistry.uuids(tabId);
}

export async function forgetInjectedState(tabId: number): Promise<void> {
  await hydrateInjectedState();
  if (injectedRegistry.forget(tabId)) persist();
}

export async function forgetInjectedScript(uuid: string): Promise<void> {
  await hydrateInjectedState();
  if (injectedRegistry.forgetScript(uuid)) persist();
}
