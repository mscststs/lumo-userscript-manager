/**
 * Document lifecycle for the runtime components.
 *
 * A document that goes into the back/forward cache is *frozen*, not destroyed:
 * it keeps its JS realm, its `MessageChannel` ports and its `chrome.runtime`
 * port, and no content script or user script is executed again when it is
 * restored. That makes `pagehide` a reversible signal, which is why every
 * runtime component needs the same three-phase model instead of treating
 * `pagehide` as "the document is gone":
 *
 * ```
 *             pagehide(persisted=true)
 *    active ─────────────────────────────▶ suspended (no-op)
 *      ▲                                        │
 *      └──────── pageshow(persisted=true) ──────┘
 *
 *    active/suspended ── pagehide(persisted=false) ──▶ terminated (one shot)
 * ```
 *
 * Invariants this module enforces for its callers:
 *
 * 1. **Suspend is reversible, so it must be harmless.** The browser may raise
 *    `pagehide(persisted=true)` and then refuse to cache the page (a held
 *    resource, a `Cache-Control: no-store` frame, ...). In that case no
 *    `pageshow` follows. Any destructive work in `onSuspend` would leave the
 *    document in a half-torn-down state, so the callback is advisory only.
 * 2. **Terminate happens at most once and is final.** A missing `persisted`
 *    flag (no bfcache support) means "really unloading", which is exactly the
 *    pre-bfcache behaviour.
 * 3. **Resume is only `pageshow(persisted=true)`.** The first `pageshow` of a
 *    fresh document also has `persisted=false` and must not be treated as a
 *    recovery, or every registration replay would run twice on load.
 * 4. **The document can disappear without any further event.** Evicting an
 *    entry from the bfcache or closing a frozen tab fires nothing here, so
 *    correctness must not depend on `onTerminate` arriving; the browser tears
 *    down ports and realms by itself.
 */

export interface PageLifecycleHandlers {
  /** Advisory: the document is being frozen. Must be harmless and reversible. */
  onSuspend?: () => void;
  /** The document was restored from the back/forward cache. */
  onResume?: () => void;
  /** The document is really going away. Called at most once, and last. */
  onTerminate?: () => void;
}

/** The narrow slice of `window` this module needs, so tests can fake it. */
export interface PageLifecycleScope {
  addEventListener(type: 'pagehide' | 'pageshow', listener: (event: PageTransitionEvent) => void): void;
  removeEventListener(
    type: 'pagehide' | 'pageshow',
    listener: (event: PageTransitionEvent) => void,
  ): void;
}

function defaultScope(): PageLifecycleScope | null {
  if (typeof window === 'undefined') return null;
  return window as unknown as PageLifecycleScope;
}

/**
 * Wire lifecycle handlers to a document.
 *
 * @returns an unsubscribe function that also marks the document as terminated.
 * Pass `null` to opt out entirely (used by unit tests and workers).
 */
export function observePageLifecycle(
  handlers: PageLifecycleHandlers,
  scope?: PageLifecycleScope | null,
): () => void {
  const target = scope === undefined ? defaultScope() : scope;
  if (!target) return () => undefined;

  let terminated = false;
  let bound = true;

  const unbind = () => {
    if (!bound) return;
    bound = false;
    target.removeEventListener('pagehide', handlePageHide);
    target.removeEventListener('pageshow', handlePageShow);
  };

  const handlePageHide = (event: PageTransitionEvent) => {
    if (terminated) return;
    if (event?.persisted === true) {
      handlers.onSuspend?.();
      return;
    }
    terminated = true;
    unbind();
    handlers.onTerminate?.();
  };

  const handlePageShow = (event: PageTransitionEvent) => {
    if (terminated) return;
    if (event?.persisted !== true) return;
    handlers.onResume?.();
  };

  target.addEventListener('pagehide', handlePageHide);
  target.addEventListener('pageshow', handlePageShow);

  return () => {
    terminated = true;
    unbind();
  };
}
