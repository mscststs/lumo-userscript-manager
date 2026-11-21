import { BridgeClient, BridgeUnavailableError } from '@/lib/runtime/transport/bridge-client';
import {
  SITE_STATE_REQUEST,
  isSiteStateMessage,
  sameOriginTarget,
  type SiteLookupResult,
  type SiteStateRequestMessage,
} from './protocol';

/**
 * Page-world half of site compatibility.
 *
 * Greasy Fork decides on its own whether to advertise an update or a reinstall:
 * it calls `window.external.Violentmonkey.isInstalled(name, namespace)` and
 * compares the returned version with the page's version. The extension is
 * therefore only responsible for exposing that one probe — the site owns the
 * button, its labels and the comparison.
 *
 * The name is the Violentmonkey one because it is the only probe on the site
 * that answers asynchronously with a plain version. Tampermonkey's shape
 * (synchronous callback plus `getVersion`/`openOptions`) would make every
 * script site believe a second manager is installed, and Greasy Fork checks it
 * before the Violentmonkey probe. Doing nothing is more honest than
 * impersonating it, and the site already supports this channel completely.
 * For the same reason the object carries no `version` field: it must not
 * advertise a manager version the extension does not have.
 *
 * ## Timing
 *
 * Greasy Fork probes once when the page loads and retries **once**, one second
 * later. A content script that waits for the settings read before claiming the
 * name loses that race on a slow first paint, and the button stays at
 * "Install this script" forever.
 *
 * The probe is therefore claimed synchronously at `document_start`, and the
 * opt-in is resolved lazily inside `isInstalled` instead:
 *
 *  - enabled → the version comes back from the background;
 *  - disabled → the promise resolves `null` (the site leaves its button alone)
 *    and the claim is withdrawn as soon as the state arrives, so a page loaded
 *    with the feature off ends up with no observable surface;
 *  - unknown (the isolated side never answers) → treated as disabled, then
 *    withdrawn.
 */

/** The `window.external` property the site probes. */
const MANAGER_KEY = 'Violentmonkey';

/** A probe never blocks the page; it exists to answer within a few hundred ms. */
const LOOKUP_TIMEOUT_MS = 8000;

/**
 * The page script and the isolated bridge both start at `document_start` in an
 * order the manifest does not promise. Re-asking a handful of times costs a few
 * `postMessage` calls and removes the race entirely.
 */
const STATE_REQUEST_ATTEMPTS = 6;
const STATE_REQUEST_INTERVAL_MS = 150;

/**
 * How long a probe waits for the opt-in state before assuming "off". Longer
 * than the request budget below so a slow content-script start still wins, and
 * short enough that the claim never lingers on a broken bridge.
 */
const STATE_TIMEOUT_MS = 2000;

export interface ManagerProbe {
  isInstalled(name: unknown, namespace?: unknown): Promise<string | null>;
}

interface ProbeDeps {
  isEnabled(): Promise<boolean>;
  lookup(name: string, namespace: string): Promise<string | null>;
}

/**
 * The object the site calls.
 *
 * Two gates in one place: a disabled feature answers `null` without waking the
 * service worker, and a lookup failure is indistinguishable from "not
 * installed" so a broken channel never renders as a version mismatch.
 */
export function createManagerProbe(deps: ProbeDeps): ManagerProbe {
  return {
    async isInstalled(name, namespace) {
      if (!(await deps.isEnabled())) return null;
      return deps.lookup(asText(name), asText(namespace));
    },
  };
}

export interface OptInGate {
  /** Resolves once the state is known; `false` if it never arrives in time. */
  isEnabled(): Promise<boolean>;
  set(enabled: boolean): void;
  dispose(): void;
}

/**
 * Single-shot latch for the opt-in value.
 *
 * The first answer settles the pending promise (a probe may already be waiting);
 * later answers only update the value, because the content-script channel can
 * keep pushing storage changes for the lifetime of the document. The timeout is
 * created once and cleared on settle, so a probe never leaves a timer behind.
 */
export function createOptInGate(timeoutMs: number): OptInGate {
  let value: boolean | null = null;
  let resolveWait: ((value: boolean) => void) | null = null;
  const wait = new Promise<boolean>((resolve) => {
    resolveWait = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    settle(false);
  }, timeoutMs);

  function settle(next: boolean): void {
    const first = value === null;
    value = next;
    if (!first) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    resolveWait?.(next);
    resolveWait = null;
  }

  return {
    isEnabled: () => (value === null ? wait : Promise.resolve(value)),
    set: settle,
    dispose() {
      settle(false);
    },
  };
}

export interface SiteExposureHandle {
  /** Remove the listener and release the claim (used on teardown and in tests). */
  stop(): void;
}

/**
 * Claim `window.external.Violentmonkey` and answer version probes.
 *
 * Idempotent claim/release: the page may turn the feature on and off while the
 * document stays open, and the claim is only ever removed when it is still ours.
 */
export function startSiteExposure(): SiteExposureHandle {
  const host = typeof window === 'undefined' ? null : externalHost();
  // Another manager already answers this probe, and its answer is at least as
  // current as ours. Two objects on one property would only hide one of them.
  if (!host || MANAGER_KEY in host) return { stop: () => undefined };

  const gate = createOptInGate(STATE_TIMEOUT_MS);

  let claim: unknown = null;
  let client: BridgeClient | null = null;
  let stopped = false;
  let answered = false;

  const dropClient = () => {
    client?.dispose();
    client = null;
  };

  const lookup = async (name: string, namespace: string): Promise<string | null> => {
    client ??= new BridgeClient({ kind: 'page', onEvent: () => undefined });
    try {
      const result = await client.call<SiteLookupResult>(
        'site:lookup',
        { name, namespace },
        { timeoutMs: LOOKUP_TIMEOUT_MS },
      );
      // A script without `@version` has nothing to compare; answering `null`
      // leaves the site's button untouched instead of inventing a downgrade.
      return result.installed && result.version ? result.version : null;
    } catch (error) {
      // `pagehide` disposes the client; re-handshake on the next probe rather
      // than keep a dead channel for the rest of the document's life.
      if (error instanceof BridgeUnavailableError) dropClient();
      return null;
    }
  };

  const probe = createManagerProbe({ isEnabled: () => gate.isEnabled(), lookup });

  const release = () => {
    if (claim === null) return;
    try {
      // Only remove our own object: the page may have replaced it meanwhile.
      if (host[MANAGER_KEY] === claim) delete host[MANAGER_KEY];
    } catch {
      // Turned non-configurable by the page; leave it alone.
    }
    claim = null;
  };

  const claimProbe = () => {
    if (claim !== null || MANAGER_KEY in host) return;
    try {
      Object.defineProperty(host, MANAGER_KEY, {
        value: probe,
        configurable: true,
        enumerable: true,
        writable: true,
      });
      claim = probe;
    } catch {
      // A page can freeze `window.external`; there is nothing useful to do.
    }
  };

  const applyState = (enabled: boolean) => {
    answered = true;
    gate.set(enabled);
    if (enabled) {
      claimProbe();
      return;
    }
    // Off means off: withdraw the probe and drop the channel instead of
    // keeping a page-to-worker port open for a feature the user disabled.
    release();
    dropClient();
  };

  const onState = (event: MessageEvent) => {
    if (event.source !== window || !isSiteStateMessage(event.data)) return;
    applyState(event.data.enabled);
  };

  const requestState = (attempt: number) => {
    if (stopped || answered || attempt >= STATE_REQUEST_ATTEMPTS) return;
    try {
      window.postMessage(
        { __lumo: SITE_STATE_REQUEST } satisfies SiteStateRequestMessage,
        sameOriginTarget(),
      );
    } catch {
      return;
    }
    setTimeout(() => requestState(attempt + 1), STATE_REQUEST_INTERVAL_MS);
  };

  // Claim before the first paint: the site's first probe must not be the one
  // that misses. `release()` withdraws it once the state is known to be off.
  claimProbe();
  window.addEventListener('message', onState);
  requestState(0);

  // A channel that never answers means "unknown", and unknown is disabled:
  // withdraw the claim so a page loaded without the feature has no surface.
  void gate.isEnabled().then((enabled) => {
    if (!stopped && !enabled) release();
  });

  return {
    stop() {
      stopped = true;
      answered = true;
      window.removeEventListener('message', onState);
      dropClient();
      release();
      gate.dispose();
    },
  };
}

/**
 * The `window.external` host object.
 *
 * Chrome ships a real `External` object, so this normally just borrows it; the
 * fallback exists for environments (tests, exotic embeds) where it is absent.
 */
function externalHost(): Record<string, unknown> | null {
  const scope = window as unknown as { external?: Record<string, unknown> };
  if (scope.external && typeof scope.external === 'object') return scope.external;
  try {
    scope.external = {};
    return scope.external;
  } catch {
    return null;
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
