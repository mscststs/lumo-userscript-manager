import { afterEach, describe, expect, it } from 'vitest';
import {
  clearMenuCommands,
  dropMenuFrame,
  listMenuCommands,
  menuRouteFrames,
  registerMenuCommand,
  unregisterMenuCommand,
} from '@/lib/background/menus';
import type { RuntimeMenuCommand } from '@/types';

/**
 * Menu registrations arrive once per frame. These tests pin the contract the
 * popup relies on: one row per command, a label from the top frame, and an
 * invocation that can still reach a live frame.
 */

const TAB = 9;

function command(overrides: Partial<RuntimeMenuCommand>): RuntimeMenuCommand {
  return {
    id: 'Toggle panel',
    uuid: 'script-1',
    title: 'Toggle panel',
    tabId: TAB,
    frameId: 0,
    ...overrides,
  };
}

afterEach(() => {
  clearMenuCommands(TAB);
});

describe('menu aggregation', () => {
  it('publishes one row for a command registered in five frames', () => {
    expect(registerMenuCommand(command({ frameId: 0 }))).toBe(true);
    for (const frameId of [1, 2, 3, 4]) {
      expect(registerMenuCommand(command({ frameId }))).toBe(false);
    }
    expect(listMenuCommands(TAB)).toHaveLength(1);
    expect(listMenuCommands(TAB)[0]).toMatchObject({ id: 'Toggle panel', frameId: 0 });
  });

  it('keeps commands from different scripts and ids distinct', () => {
    registerMenuCommand(command({ frameId: 0 }));
    registerMenuCommand(command({ frameId: 0, id: 'second', title: 'Second' }));
    registerMenuCommand(command({ frameId: 0, uuid: 'script-2' }));
    expect(listMenuCommands(TAB).map((item) => `${item.uuid}/${item.id}`).sort()).toEqual([
      'script-1/Toggle panel',
      'script-1/second',
      'script-2/Toggle panel',
    ]);
  });

  it('prefers the top frame label but falls back to an iframe', () => {
    registerMenuCommand(command({ frameId: 2, title: 'From frame' }));
    expect(listMenuCommands(TAB)[0]).toMatchObject({ title: 'From frame', frameId: 2 });

    registerMenuCommand(command({ frameId: 0, title: 'From top' }));
    expect(listMenuCommands(TAB)[0]).toMatchObject({ title: 'From top', frameId: 0 });
  });

  it('keeps a command alive while another frame still has it', () => {
    registerMenuCommand(command({ frameId: 0 }));
    registerMenuCommand(command({ frameId: 1 }));

    // The top frame unregisters: the iframe copy remains, and its label wins.
    unregisterMenuCommand(TAB, 0, 'script-1', 'Toggle panel');
    expect(listMenuCommands(TAB)).toHaveLength(1);
    expect(listMenuCommands(TAB)[0]?.frameId).toBe(1);

    unregisterMenuCommand(TAB, 1, 'script-1', 'Toggle panel');
    expect(listMenuCommands(TAB)).toEqual([]);
  });

  it('clears every command of a tab on a top-level commit', () => {
    registerMenuCommand(command({ frameId: 0 }));
    registerMenuCommand(command({ frameId: 3 }));
    clearMenuCommands(TAB);
    expect(listMenuCommands(TAB)).toEqual([]);
  });

  it('drops a frame when its document goes away', () => {
    registerMenuCommand(command({ frameId: 0 }));
    registerMenuCommand(command({ frameId: 3, uuid: 'script-2' }));
    expect(dropMenuFrame(TAB, 3)).toBe(true);
    expect(listMenuCommands(TAB).map((item) => item.uuid)).toEqual(['script-1']);
    expect(dropMenuFrame(TAB, 3)).toBe(false);
  });
});

describe('menu routing', () => {
  it('routes to the preferred frame first, then ascending', () => {
    for (const frameId of [0, 2, 5]) registerMenuCommand(command({ frameId }));
    expect(menuRouteFrames(TAB, 'script-1', 'Toggle panel')).toEqual([0, 2, 5]);
    expect(menuRouteFrames(TAB, 'script-1', 'Toggle panel', 5)).toEqual([5, 0, 2]);
    expect(menuRouteFrames(TAB, 'script-1', 'Toggle panel', 4)).toEqual([0, 2, 5]);
  });

  it('returns nothing for a command that no frame registered', () => {
    expect(menuRouteFrames(TAB, 'script-1', 'missing')).toEqual([]);
  });
});
