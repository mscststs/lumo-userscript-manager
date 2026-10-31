import { checkUserScriptsAvailable } from '@/lib/background/registry';
import { promptForRequest, recordPendingRequest } from './pending';
import { storage } from '@/store/storage';
import {
  AGENT_NAMESPACE,
  AGENT_SERVICE_NAME,
  PROBE_VERSION,
  type ProbeRequest,
  type ProbeResponse,
} from './protocol';

/**
 * L0 discovery/control handler.
 *
 * Must answer even when the endpoint is disabled or the caller is not allowed,
 * otherwise the host cannot show "installed but off" or "allow this extension".
 * The response stays metadata-only until both checks pass; capabilities are
 * only exchanged over MCP after authorization.
 */
export async function handleProbe(
  request: ProbeRequest,
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
        message: `Unsupported probe version ${request.version}; this build speaks ${PROBE_VERSION}.`,
      },
    };
  }

  const settings = await storage.getAgentSettings();
  const senderId = sender.id ?? '';
  const authorized = Boolean(
    senderId && settings.allowedExtensionIds.includes(senderId),
  );
  const availability = await checkUserScriptsAvailable();

  // Unknown callers become pending approval requests. This is also what makes
  // the one-step onboarding possible: the host only needs to know this
  // extension's ID; the user approves the host here, not by copying IDs twice.
  const pending = authorized
    ? undefined
    : await recordPendingRequest(senderId, request.client);
  if (pending && !pending.dismissedAt) {
    void promptForRequest(pending);
  }

  return {
    ok: true,
    service,
    status: {
      enabled: settings.enabled,
      authorized,
      ready: availability.ok,
      ...(pending && !pending.dismissedAt ? { pendingApproval: true } : {}),
      ...(availability.ok
        ? {}
        : {
            reason: {
              code: 'USER_SCRIPTS_UNAVAILABLE',
              message: availability.error ?? 'chrome.userScripts is not available.',
            },
          }),
    },
  };
}
