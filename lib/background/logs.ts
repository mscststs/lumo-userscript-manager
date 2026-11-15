import type { LogEntry, UISettings, UserScript } from '@/types';
import { addLogs, getScript, pruneLogs } from '@/lib/db';
import { storage } from '@/store/storage';
import { announceLogsChanged } from './events';

const LEVEL_WEIGHT: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_MESSAGE_CHARS = 16 * 1024;
const FLUSH_MS = 100;
const MAX_BATCH = 128;
const MAX_PENDING = 512;

let settingsCache: { value: UISettings; at: number } | null = null;
const nameCache = new Map<string, { name: string; at: number }>();
const pending: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;
let dropped = 0;
let writesSincePrune = 0;

async function getLogSettings(): Promise<UISettings> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < 5_000) return settingsCache.value;
  const value = await storage.getUISettings();
  settingsCache = { value, at: now };
  return value;
}

async function getScriptName(uuid: string): Promise<string | undefined> {
  const now = Date.now();
  const cached = nameCache.get(uuid);
  if (cached && now - cached.at < 60_000) return cached.name;
  const script: UserScript | undefined = await getScript(uuid);
  if (!script) return undefined;
  nameCache.set(uuid, { name: script.name, at: now });
  return script.name;
}

async function flushLogs(): Promise<void> {
  flushTimer = undefined;
  if (flushing || pending.length === 0) return;
  flushing = true;
  try {
    while (pending.length > 0) {
      const batch = pending.splice(0, MAX_BATCH);
      try {
        await addLogs(batch);
        writesSincePrune += batch.length;
        if (writesSincePrune >= 5_000) {
          writesSincePrune = 0;
          void pruneLogs().catch(() => undefined);
        }
        announceLogsChanged();
      } catch (error) {
        // Preserve the next batch even if one write fails; logs are diagnostic,
        // not a reason to break the API call that produced them.
        console.warn('[Lumo Userscripts] Failed to persist log batch:', error);
      }
    }
  } finally {
    flushing = false;
    if (pending.length > 0) scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => void flushLogs(), FLUSH_MS);
}

function enqueue(entry: LogEntry): void {
  if (pending.length >= MAX_PENDING) {
    dropped += 1;
    if (dropped === 1 || dropped % 100 === 0) {
      console.warn(`[Lumo Userscripts] Dropped ${dropped} log entries under load.`);
    }
    return;
  }
  pending.push(entry);
  if (pending.length >= 32) void flushLogs();
  else scheduleFlush();
}

export async function recordLog(
  level: LogEntry['level'],
  args: unknown[],
  uuid?: string,
  url?: string,
): Promise<void> {
  const settings = await getLogSettings();
  const threshold = LEVEL_WEIGHT[settings.logLevel] ?? 20;
  if ((LEVEL_WEIGHT[level] ?? 20) < threshold) return;

  const name = uuid ? await getScriptName(uuid) : undefined;
  let message = args
    .map((value) => {
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');

  if (message.length > MAX_MESSAGE_CHARS) {
    message = `${message.slice(0, MAX_MESSAGE_CHARS)}… [truncated]`;
  }

  enqueue({
    level,
    message,
    uuid,
    name,
    url,
    time: Date.now(),
  });
}
