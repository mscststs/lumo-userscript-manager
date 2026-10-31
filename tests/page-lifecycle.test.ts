import { describe, expect, it, vi } from 'vitest';
import {
  observePageLifecycle,
  type PageLifecycleScope,
} from '@/lib/runtime/lifecycle';

class FakeLifecycleScope implements PageLifecycleScope {
  private readonly listeners = new Map<string, Set<(event: PageTransitionEvent) => void>>();

  addEventListener(type: 'pagehide' | 'pageshow', listener: (event: PageTransitionEvent) => void): void {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(
    type: 'pagehide' | 'pageshow',
    listener: (event: PageTransitionEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: 'pagehide' | 'pageshow', event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event as PageTransitionEvent);
    }
  }

  count(): number {
    let total = 0;
    for (const bucket of this.listeners.values()) total += bucket.size;
    return total;
  }
}

function transition(persisted?: boolean): PageTransitionEvent {
  return { persisted } as PageTransitionEvent;
}

describe('observePageLifecycle', () => {
  it('suspends without terminating and survives repeated round trips', () => {
    const scope = new FakeLifecycleScope();
    const onSuspend = vi.fn();
    const onResume = vi.fn();
    const onTerminate = vi.fn();
    observePageLifecycle({ onSuspend, onResume, onTerminate }, scope);

    scope.dispatch('pagehide', transition(true));
    scope.dispatch('pageshow', transition(true));
    scope.dispatch('pagehide', transition(true));
    scope.dispatch('pageshow', transition(true));

    expect(onSuspend).toHaveBeenCalledTimes(2);
    expect(onResume).toHaveBeenCalledTimes(2);
    expect(onTerminate).not.toHaveBeenCalled();
  });

  it('treats a missing persisted flag as a real unload', () => {
    const scope = new FakeLifecycleScope();
    const onSuspend = vi.fn();
    const onTerminate = vi.fn();
    observePageLifecycle({ onSuspend, onTerminate }, scope);

    scope.dispatch('pagehide', transition());

    expect(onSuspend).not.toHaveBeenCalled();
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it('ignores the pageshow of a freshly loaded document', () => {
    const scope = new FakeLifecycleScope();
    const onResume = vi.fn();
    observePageLifecycle({ onResume }, scope);

    scope.dispatch('pageshow', transition(false));
    scope.dispatch('pageshow', transition());

    expect(onResume).not.toHaveBeenCalled();
  });

  it('terminates exactly once and stays terminal', () => {
    const scope = new FakeLifecycleScope();
    const onTerminate = vi.fn();
    const onResume = vi.fn();
    observePageLifecycle({ onResume, onTerminate }, scope);

    scope.dispatch('pagehide', transition(false));
    scope.dispatch('pagehide', transition(false));
    scope.dispatch('pageshow', transition(true));

    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
    // The listeners are gone: nothing can fire again.
    expect(scope.count()).toBe(0);
  });

  it('stops delivering after unsubscribe', () => {
    const scope = new FakeLifecycleScope();
    const onResume = vi.fn();
    const onTerminate = vi.fn();
    const unsubscribe = observePageLifecycle({ onResume, onTerminate }, scope);

    unsubscribe();
    expect(scope.count()).toBe(0);
    scope.dispatch('pageshow', transition(true));
    scope.dispatch('pagehide', transition(false));

    expect(onResume).not.toHaveBeenCalled();
    expect(onTerminate).not.toHaveBeenCalled();
  });

  it('accepts a null scope for environments without a document', () => {
    expect(() => observePageLifecycle({ onResume: () => undefined }, null)()).not.toThrow();
  });
});
