import { checkUserScriptsAvailable } from '@/lib/background/registry';
import { storage } from '@/store/storage';
import {
  AGENT_NAMESPACE,
  AGENT_SERVICE_NAME,
  PROBE_VERSION,
  type ProbeRequest,
  type ProbeResponse,
} from './protocol';

/**
 * L0 discovery: who am I, and would I accept you?
 *
 * Deliberately free of side effects — it reads settings and answers. No pending
 * request, no prompt, no tab. That is what makes it safe for a host to send from
 * a startup pass, a focus retry, or a catalog scan over extensions the user has
 * not added; and it is also why the answer cannot depend on having been called
 * before.
 *
 * The answer must be `ok:true` even when the endpoint is off or the caller is not
 * allowed: only `ok:false` means "this is not a Lumo endpoint". Turning a refusal
 * into a failed request is what would make "installed but off" indistinguishable
 * from "not installed".
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
  // One switch decides whether this extension takes part in host integration at
  // all. Off means "do not advertise me": hosts see no endpoint, so nothing can
  // be added and nothing can be approved. `enabled` (the agent master switch) is
  // deliberately *not* consulted here — an endpoint that is off must still be
  // discoverable, because approving it is what turns it on.
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
  const authorized = Boolean(senderId && settings.allowedExtensionIds.includes(senderId));
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
