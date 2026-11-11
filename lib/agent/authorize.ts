import { checkUserScriptsAvailable } from '@/lib/background/registry';
import { isAllowedClient } from './allowlist';
import { promptForRequest, recordPendingRequest, rememberAllowedClient } from './pending';
import { storage } from '@/store/storage';
import {
  AGENT_NAMESPACE,
  AGENT_SERVICE_NAME,
  PROBE_VERSION,
  type AuthorizeRequest,
  type ProbeResponse,
} from './protocol';

/**
 * L0 authorization: the user asked the host to use this extension.
 *
 * The only L0 message with side effects, and the only one allowed to steal focus
 * — the host's "Authorize" button is the user agreeing to be asked here, so the
 * approval card is opened in this extension's own settings. Everything the probe
 * deliberately does not do happens in one place:
 *
 *   1. record (or refresh) the pending request, so the approval card is waiting
 *      even if the tab fails to open;
 *   2. open the settings page at that card, subject to its own cooldowns;
 *   3. answer with the current status — almost always `authorized:false`, because
 *      the approval happens in the UI the user is being sent to.
 *
 * Approval itself is `approvePendingRequest`, driven by the settings page. The
 * host learns the outcome by probing again (it retries on focus), so no message
 * ever needs to travel back to it.
 */
export async function handleAuthorize(
  request: AuthorizeRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ProbeResponse> {
  const service = {
    namespace: AGENT_NAMESPACE,
    name: AGENT_SERVICE_NAME,
    version: chrome.runtime.getManifest().version,
  };

  if (request.version !== PROBE_VERSION) {
    return {
      ok: false,
      service,
      error: {
        code: 'UNSUPPORTED_PROTOCOL',
        message: `Unsupported authorize version ${request.version}; this build speaks ${PROBE_VERSION}.`,
      },
    };
  }

  const settings = await storage.getAgentSettings();
  // Same gate as the probe: with host integration switched off there is no card
  // to show and no request to record.
  if (!settings.promptOnRequest) {
    return {
      ok: false,
      service,
      error: {
        code: 'REQUESTS_DISABLED',
        message: `${AGENT_SERVICE_NAME} does not accept requests from other extensions. Turn on “Open settings when an extension asks” in its settings.`,
      },
    };
  }

  const senderId = sender.id ?? '';
  const authorized = isAllowedClient(settings, senderId);

  // Already allowed: nothing to ask. Answering the same shape as the probe keeps
  // the host's handling identical for both messages.
  //
  // The record-and-prompt pipeline is deliberately not awaited: it writes
  // storage and opens a tab, and the host is waiting on this reply with a
  // timeout. A slow prompt must never make the call look unanswered. An
  // already-allowed caller is only refreshed — never re-queued — so it keeps
  // its name and version in the allowlist without producing a card.
  if (authorized) {
    void rememberAllowedClient(senderId, request.client);
  } else {
    void recordPendingRequest(senderId, request.client).then((pending) =>
      promptForRequest(pending),
    );
  }

  const availability = await checkUserScriptsAvailable();

  return {
    ok: true,
    service,
    status: {
      enabled: settings.enabled,
      authorized,
      ready: availability.ok,
      ...(availability.ok
        ? {}
        : {
            reason: {
              code: 'USER_SCRIPTS_UNAVAILABLE',
              message: availability.error ?? 'The userScripts API is not available.',
            },
          }),
    },
  };
}
