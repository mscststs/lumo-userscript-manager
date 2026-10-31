import type { LogEntry, UserScript } from '@/types';
import { addLog, getScript } from '@/lib/db';
import { storage } from '@/store/storage';
import { announceLogsChanged } from './events';

const LEVEL_WEIGHT: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export async function recordLog(
  level: LogEntry['level'],
  args: unknown[],
  uuid?: string,
  url?: string,
): Promise<void> {
  const settings = await storage.getUISettings();
  const threshold = LEVEL_WEIGHT[settings.logLevel] ?? 20;
  if ((LEVEL_WEIGHT[level] ?? 20) < threshold) return;

  const script: UserScript | undefined = uuid ? await getScript(uuid) : undefined;
  const message = args
    .map((value) => {
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');

  await addLog({
    level,
    message,
    uuid,
    name: script?.name,
    url,
    time: Date.now(),
  });
  announceLogsChanged();
}
