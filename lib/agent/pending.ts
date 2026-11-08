import type { AgentPendingRequest, AgentSettings } from '@/types';
import { storage } from '@/store/storage';
import { openOptionsTab } from '@/lib/options-tab';
import { isExtensionId } from './protocol';

/**
 * Serialized so two hosts answering at once cannot lose a record: every write
 * below is a read-modify-write over the whole queue.
 */
let chain: Promise<unknown> = Promise.resolve();

/** Serialize read-modify-write cycles on the two storage keys. */
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function sanitizeClient(client: { name?: string; version?: string } | undefined): {
  name?: string;
  version?: string;
} {
  const name = client?.name?.trim().slice(0, 80);
  const version = client?.version?.trim().slice(0, 32);
  return {
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
  };
}

/**
 * Record a caller that asked for access as a pending approval request.
 *
 * Called from the `lumo:authorize` handler — never from the probe, which must
 * stay read-only. A repeat request from the same extension reuses its row (and
 * revives it if the user had dismissed it), so asking again always produces a
 * card to approve.
 */
export function recordPendingRequest(
  senderId: string | undefined,
  client: { name?: string; version?: string } | undefined,
): Promise<AgentPendingRequest | undefined> {
  if (!senderId || !isExtensionId(senderId)) return Promise.resolve(undefined);

  return serialize(async () => {
    try {
      const settings = await storage.getAgentSettings();
      if (settings.allowedExtensionIds.includes(senderId)) return undefined;

      const requests = await storage.getAgentPendingRequests();
      const now = Date.now();
      const existing = requests.find((request) => request.id === senderId);
      const details = sanitizeClient(client);

      let request: AgentPendingRequest;
      if (existing) {
        request = {
          ...existing,
          ...details,
          lastSeen: now,
        };
        // An explicit request outranks an earlier dismissal: the user (or their
        // host) asked again, so the card must be actionable again.
        delete request.dismissedAt;
      } else {
        request = {
          id: senderId,
          ...details,
          firstSeen: now,
          lastSeen: now,
        };
      }

      const next = [request, ...requests.filter((entry) => entry.id !== senderId)].slice(0, 5);
      await storage.setAgentPendingRequests(next);
      return request;
    } catch (error) {
      console.warn('[Lumo Userscripts] Failed to record an agent access request:', error);
      return undefined;
    }
  });
}

/**
 * Show the approval card, every single time it is asked for.
 *
 * `lumo:authorize` is only sent from a host's explicit "Authorize" button, so
 * there is no rate limit to apply: a click that produced no visible result would
 * just look broken. Cooldowns used to live here (per-request 24h, global 10s) and
 * were exactly why a second attempt appeared to do nothing. The only remaining
 * gate is the user's own "open settings when an extension asks" switch, which is
 * also what hides this extension from host discovery.
 *
 * `promptedAt` is still stamped: the in-page dialog (`shouldOpenAgentPrompt`)
 * uses it to know the queue entry was announced just now, rather than being an
 * old row the user has already seen.
 */
export async function promptForRequest(request: AgentPendingRequest | undefined): Promise<void> {
  if (!request) return;
  try {
    const settings = await storage.getAgentSettings();
    if (!settings.promptOnRequest) return;

    const now = Date.now();
    await serialize(async () => {
      const requests = await storage.getAgentPendingRequests();
      await storage.setAgentPendingRequests(
        requests.map((entry) =>
          entry.id === request.id ? { ...entry, promptedAt: now } : entry,
        ),
      );
    });

    await openOptionsTab('#/settings/agent');
  } catch (error) {
    console.warn('[Lumo Userscripts] Failed to prompt for agent access:', error);
  }
}

/** Approve one request: enable the endpoint and add the extension to the allowlist. */
export function approvePendingRequest(senderId: string): Promise<AgentSettings | undefined> {
  if (!isExtensionId(senderId)) return Promise.resolve(undefined);

  return serialize(async () => {
    const settings = await storage.getAgentSettings();
    const next: AgentSettings = {
      ...settings,
      enabled: true,
      allowedExtensionIds: Array.from(
        new Set([...settings.allowedExtensionIds, senderId]),
      ).slice(0, 16),
    };
    await storage.setAgentSettings(next);
    const requests = await storage.getAgentPendingRequests();
    await storage.setAgentPendingRequests(
      requests.filter((request) => request.id !== senderId),
    );
    return next;
  });
}

/** Dismiss a request; a new `lumo:authorize` from that caller revives it. */
export function dismissPendingRequest(senderId: string): Promise<void> {
  if (!isExtensionId(senderId)) return Promise.resolve();

  return serialize(async () => {
    const requests = await storage.getAgentPendingRequests();
    const now = Date.now();
    await storage.setAgentPendingRequests(
      requests.map((request) =>
        request.id === senderId ? { ...request, dismissedAt: now } : request,
      ),
    );
  });
}
