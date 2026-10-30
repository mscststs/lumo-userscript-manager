import type { RuntimeMenuCommand } from '@/types';

const commands = new Map<string, RuntimeMenuCommand[]>();

function key(tabId: number, frameId: number, uuid: string): string {
  return `${tabId}:${frameId}:${uuid}`;
}

export function registerMenuCommand(command: RuntimeMenuCommand): void {
  const k = key(command.tabId, command.frameId, command.uuid);
  const list = commands.get(k) ?? [];
  const index = list.findIndex((item) => item.id === command.id);
  if (index >= 0) list[index] = command;
  else list.push(command);
  commands.set(k, list);
}

export function unregisterMenuCommand(
  tabId: number,
  frameId: number,
  uuid: string,
  id: string,
): void {
  const k = key(tabId, frameId, uuid);
  const list = commands.get(k);
  if (!list) return;
  commands.set(
    k,
    list.filter((item) => item.id !== id),
  );
}

export function listMenuCommands(tabId: number): RuntimeMenuCommand[] {
  const result: RuntimeMenuCommand[] = [];
  for (const [k, list] of commands) {
    if (k.startsWith(`${tabId}:`)) result.push(...list);
  }
  return result;
}

export function clearMenuCommands(tabId: number, frameId?: number): void {
  for (const k of [...commands.keys()]) {
    const [t, f] = k.split(':').map(Number);
    if (t === tabId && (frameId === undefined || f === frameId)) commands.delete(k);
  }
}
