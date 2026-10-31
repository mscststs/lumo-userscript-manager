import { describe, expect, it } from 'vitest';
import { InjectedRegistry } from '@/lib/background/injected-state';

/**
 * The registry is what makes the badge honest: it remembers which scripts
 * actually reported a start, per document and per frame. Every case below is a
 * situation the old predicted count could not express.
 */

describe('injected registry', () => {
  it('counts a script once across frames', () => {
    const registry = new InjectedRegistry();
    expect(registry.note(1, 0, 'script')).toBe(true);
    expect(registry.note(1, 3, 'script')).toBe(false);
    expect(registry.note(1, 7, 'script')).toBe(false);
    expect(registry.uuids(1)).toEqual(['script']);
  });

  it('counts scripts that only run in a frame', () => {
    const registry = new InjectedRegistry();
    registry.note(1, 0, 'page-script');
    registry.note(1, 4, 'embed-script');
    expect(registry.uuids(1).sort()).toEqual(['embed-script', 'page-script']);
  });

  it('keeps tabs independent', () => {
    const registry = new InjectedRegistry();
    registry.note(1, 0, 'a');
    registry.note(2, 0, 'b');
    expect(registry.uuids(1)).toEqual(['a']);
    expect(registry.uuids(2)).toEqual(['b']);
  });

  it('drops late reports from the document the frame navigated away from', () => {
    const registry = new InjectedRegistry();
    registry.resetTab(1, { documentId: 'doc-2', url: 'https://b.test/' });
    // In-flight report from the previous document.
    expect(registry.note(1, 0, 'old', { documentId: 'doc-1' })).toBe(false);
    expect(registry.uuids(1)).toEqual([]);
    // The new document reports normally.
    expect(registry.note(1, 0, 'new', { documentId: 'doc-2' })).toBe(true);
    expect(registry.uuids(1)).toEqual(['new']);
  });

  it('accepts reports when the document id is unavailable', () => {
    const registry = new InjectedRegistry();
    registry.resetTab(1, { documentId: 'doc-2' });
    // A browser build without `sender.documentId` must still count.
    expect(registry.note(1, 0, 'script')).toBe(true);
    expect(registry.uuids(1)).toEqual(['script']);
  });

  it('clears the whole tab when the top document commits', () => {
    const registry = new InjectedRegistry();
    registry.note(1, 0, 'a');
    registry.note(1, 2, 'b');
    registry.resetTab(1, { documentId: 'doc-2' });
    expect(registry.uuids(1)).toEqual([]);
  });

  it('clears one frame when a sub-frame document commits', () => {
    const registry = new InjectedRegistry();
    registry.note(1, 0, 'top');
    registry.note(1, 2, 'frame');
    registry.resetFrame(1, 2, { documentId: 'frame-doc-2' });
    expect(registry.uuids(1)).toEqual(['top']);
    expect(registry.note(1, 2, 'stale', { documentId: 'frame-doc-1' })).toBe(false);
    expect(registry.note(1, 2, 'frame2', { documentId: 'frame-doc-2' })).toBe(true);
    expect(registry.uuids(1).sort()).toEqual(['frame2', 'top']);
  });

  it('forgets a tab', () => {
    const registry = new InjectedRegistry();
    registry.note(1, 0, 'a');
    expect(registry.forget(1)).toBe(true);
    expect(registry.forget(1)).toBe(false);
    expect(registry.uuids(1)).toEqual([]);
  });

  it('survives a round trip through the session snapshot', () => {
    const registry = new InjectedRegistry();
    registry.note(1, 0, 'a', { documentId: 'doc-1', url: 'https://a.test/' });
    registry.note(1, 3, 'b');

    const restored = new InjectedRegistry();
    restored.restore(JSON.parse(JSON.stringify(registry.snapshot())));

    expect(restored.uuids(1).sort()).toEqual(['a', 'b']);
    // The restored document id still rejects a late report from before.
    expect(restored.note(1, 0, 'stale', { documentId: 'doc-0' })).toBe(false);
    expect(restored.note(1, 0, 'c', { documentId: 'doc-1' })).toBe(true);
  });

  it('ignores a corrupt snapshot instead of throwing', () => {
    const registry = new InjectedRegistry();
    registry.restore('nonsense');
    expect(registry.uuids(1)).toEqual([]);
    registry.restore({ 1: { 0: { scripts: ['a', 3, null] } }, x: 'y', 2: { 1: 'nope' } });
    expect(registry.uuids(1)).toEqual(['a']);
    expect(registry.uuids(2)).toEqual([]);
  });
});
