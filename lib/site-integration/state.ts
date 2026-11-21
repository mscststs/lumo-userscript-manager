import {
  SITE_STATE,
  isSiteStateRequest,
  isSupportedSiteHost,
  sameOriginTarget,
  type SiteStateMessage,
} from './protocol';

const UI_SETTINGS_KEY = 'uiSettings';

/**
 * Everything the state channel needs from the document.
 *
 * Injected rather than read from globals so the channel itself stays a pure
 * "publish the opt-in" function: the storage/subscription plumbing lives in
 * `defaultSiteStateScope()` and is the only part that touches `chrome`.
 */
export interface SiteStateScope {
  hostname: string;
  /** Only the top document runs the page script that probes. */
  isTopFrame: boolean;
  /** Current opt-in value. */
  readOptIn(): Promise<boolean>;
  /** Fires whenever the stored opt-in changes. */
  onOptInChange(listener: (enabled: boolean) => void): void;
  /** Fires when the page script asks for the current value. */
  onPageRequest(listener: () => void): void;
  post(message: SiteStateMessage): void;
}

/**
 * Read the opt-in straight from `chrome.storage.local`.
 *
 * `store/storage.ts` is the normal entry point, but this runs in a content
 * script injected into every script-site page and must stay free of the
 * settings bundle. The channel needs one boolean and one change feed; routing
 * it through the store would pull the whole schema (theme, agent, backup types)
 * into a script paid for on every navigation. The background normalizes the
 * same value with `STORAGE_FIELDS.uiSettings` before answering probes, so the
 * two readers agree on what "on" means.
 */
function readOptIn(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(UI_SETTINGS_KEY, (items) => {
        // Reading the error clears Chrome's "unchecked runtime.lastError"
        // warning; a failure means "off", never "on".
        void chrome.runtime.lastError;
        const settings = items?.[UI_SETTINGS_KEY] as { siteIntegration?: unknown } | undefined;
        resolve(settings?.siteIntegration === true);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Isolated-world half of site compatibility.
 *
 * The page script cannot read settings, and the two scripts start in an
 * unspecified order at `document_start`, so this side both pushes the value on
 * change and answers an explicit request from the page. Whichever starts first,
 * the other converges within one round trip.
 *
 * Inert by default: on any other host it returns before touching either
 * channel.
 */
export function startSiteStateChannel(scope: SiteStateScope): void {
  if (!scope.isTopFrame || !isSupportedSiteHost(scope.hostname)) return;

  let enabled = false;
  const publish = () => scope.post({ __lumo: SITE_STATE, enabled });

  scope.onPageRequest(publish);
  scope.onOptInChange((value) => {
    enabled = value;
    publish();
  });
  void scope.readOptIn().then((value) => {
    enabled = value;
    publish();
  });
}

/** Global-backed scope used by the content-script entry point. */
export function defaultSiteStateScope(): SiteStateScope {
  return {
    hostname: location.hostname,
    isTopFrame: window.top === window,
    readOptIn,
    onOptInChange(listener) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes[UI_SETTINGS_KEY]) return;
        const next = changes[UI_SETTINGS_KEY].newValue as
          | { siteIntegration?: unknown }
          | undefined;
        listener(next?.siteIntegration === true);
      });
    },
    onPageRequest(listener) {
      window.addEventListener('message', (event) => {
        if (event.source !== window || !isSiteStateRequest(event.data)) return;
        listener();
      });
    },
    post(message) {
      try {
        window.postMessage(message, sameOriginTarget());
      } catch {
        // A detached document has nobody left to answer.
      }
    },
  };
}
