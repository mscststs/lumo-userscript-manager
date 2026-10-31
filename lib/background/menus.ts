import type { RuntimeMenuCommand } from '@/types';

/**
 * `GM_registerMenuCommand` registry, aggregated across frames.
 *
 * A registered userscript runs in every matching frame, so the same command is
 * registered once per frame. Publishing those registrations verbatim made the
 * popup show one row per iframe — four rows for a page with four iframes, only
 * one of which could actually be invoked. Commands are therefore keyed by
 * `(script, command id)` and merged:
 *
 *  - the popup sees one row per command, exactly like the script wrote it;
 *  - every frame that registered the command is remembered as a route, so an
 *    invocation still reaches a live frame (top frame first, then ascending
 *    frame id);
 *  - the top frame's label wins, because that is the document the user is
 *    looking at; an iframe-only command falls back to the lowest frame.
 *
 * `GM_registerMenuCommand` derives its id from `options.id` or the title
 * (`lib/runtime/gm-api.ts`), which is what makes the merge exact across frames.
 */

interface FrameMenu {
  title: string;
  accessKey?: string;
}

interface MenuEntry {
  id: string;
  uuid: string;
  tabId: number;
  /** Per-frame registration; frame 0 — when present — decides the label. */
  frames: Map<number, FrameMenu>;
}

const tabs = new Map<number, Map<string, MenuEntry>>();

function entryKey(uuid: string, id: string): string {
  return `${uuid}\u0000${id}`;
}

function displayedFrame(entry: MenuEntry): number {
  return entry.frames.has(0) ? 0 : Math.min(...entry.frames.keys());
}

function displayedLabel(entry: MenuEntry): FrameMenu {
  return entry.frames.get(displayedFrame(entry))!;
}

function tabEntries(tabId: number): Map<string, MenuEntry> | undefined {
  return tabs.get(tabId);
}

/**
 * Register (or refresh) one frame's command.
 *
 * Returns true when the popup list changes, so callers only broadcast then —
 * five frames registering the same command should not wake the popup five times.
 */
export function registerMenuCommand(command: RuntimeMenuCommand): boolean {
  let entries = tabs.get(command.tabId);
  if (!entries) {
    entries = new Map();
    tabs.set(command.tabId, entries);
  }
  const key = entryKey(command.uuid, command.id);
  const frame: FrameMenu = { title: command.title, accessKey: command.accessKey };
  const existing = entries.get(key);
  if (!existing) {
    entries.set(key, {
      id: command.id,
      uuid: command.uuid,
      tabId: command.tabId,
      frames: new Map([[command.frameId, frame]]),
    });
    return true;
  }
  const before = displayedLabel(existing);
  existing.frames.set(command.frameId, frame);
  const after = displayedLabel(existing);
  return before.title !== after.title || before.accessKey !== after.accessKey;
}

/** Drop one frame's registration; the command survives while any frame holds it. */
export function unregisterMenuCommand(
  tabId: number,
  frameId: number,
  uuid: string,
  id: string,
): boolean {
  const entries = tabEntries(tabId);
  if (!entries) return false;
  const key = entryKey(uuid, id);
  const entry = entries.get(key);
  if (!entry) return false;
  const before = displayedLabel(entry);
  if (!entry.frames.delete(frameId)) return false;
  if (entry.frames.size === 0) {
    entries.delete(key);
    if (entries.size === 0) tabs.delete(tabId);
    return true;
  }
  if (frameId === 0) {
    // The top frame owned the label; an iframe's copy takes over.
    const after = displayedLabel(entry);
    return before.title !== after.title || before.accessKey !== after.accessKey;
  }
  return false;
}

/** The merged view the popup renders: one row per command. */
export function listMenuCommands(tabId: number): RuntimeMenuCommand[] {
  const entries = tabEntries(tabId);
  if (!entries) return [];
  const result: RuntimeMenuCommand[] = [];
  for (const entry of entries.values()) {
    const frameId = displayedFrame(entry);
    const label = entry.frames.get(frameId)!;
    result.push({
      id: entry.id,
      uuid: entry.uuid,
      tabId: entry.tabId,
      title: label.title,
      accessKey: label.accessKey,
      frameId,
    });
  }
  return result;
}

/**
 * Frames able to run a command, best first.
 *
 * The preferred frame is whatever the popup displayed; the rest follow in
 * ascending order (the top frame is 0). Callers try them in order and stop at
 * the first live port, so a command registered only in an iframe still works.
 */
export function menuRouteFrames(
  tabId: number,
  uuid: string,
  id: string,
  preferred?: number,
): number[] {
  const entry = tabEntries(tabId)?.get(entryKey(uuid, id));
  if (!entry) return [];
  const frames = [...entry.frames.keys()].sort((a, b) => a - b);
  if (preferred === undefined || !frames.includes(preferred)) return frames;
  return [preferred, ...frames.filter((frame) => frame !== preferred)];
}

/** Forget a frame (its port closed); returns true when a visible row vanished. */
export function dropMenuFrame(tabId: number, frameId: number): boolean {
  const entries = tabEntries(tabId);
  if (!entries) return false;
  let changed = false;
  for (const [key, entry] of [...entries]) {
    if (!entry.frames.has(frameId)) continue;
    const before = displayedLabel(entry);
    entry.frames.delete(frameId);
    if (entry.frames.size === 0) {
      entries.delete(key);
      changed = true;
      continue;
    }
    const after = displayedLabel(entry);
    if (before.title !== after.title || before.accessKey !== after.accessKey) changed = true;
  }
  if (entries.size === 0) tabs.delete(tabId);
  return changed;
}

export function clearMenuCommands(tabId: number, frameId?: number): void {
  if (frameId === undefined) {
    tabs.delete(tabId);
    return;
  }
  dropMenuFrame(tabId, frameId);
}
