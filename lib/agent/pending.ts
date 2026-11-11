import type { AgentPendingRequest, AgentSettings } from '@/types';
import { storage } from '@/store/storage';
import { openOptionsTab } from '@/lib/options-tab';
import { findAllowedClient, upsertAllowedClient } from './allowlist';
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
      if (findAllowedClient(settings, senderId)) return undefined;

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
    const [settings, requests] = await Promise.all([
      storage.getAgentSettings(),
      storage.getAgentPendingRequests(),
    ]);
    // Read the queue *before* deleting the row: the self-reported name and
    // version the host sent with `lumo:authorize` are the only chance to keep
    // them, and a bare ID is what left the allowlist anonymous.
    const pending = requests.find((request) => request.id === senderId);
    const next: AgentSettings = {
      ...settings,
      enabled: true,
      allowedClients: upsertAllowedClient(settings.allowedClients, {
        id: senderId,
        ...(pending?.name ? { name: pending.name } : {}),
        ...(pending?.version ? { version: pending.version } : {}),
      }),
    };
    await storage.setAgentSettings(next);
    await storage.setAgentPendingRequests(
      requests.filter((request) => request.id !== senderId),
    );
    return next;
  });
}

/**
 * Refresh the display details of an already-allowed caller.
 *
 * `lumo:authorize` carries the host's self-reported name and version every time
 * the user asks to connect, so an ID that was allowlisted by hand — or migrated
 * from a build that only stored IDs — gains a face the next time that host
 * identifies itself. Called from authorize only: the probe must stay read-only.
 *
 * A no-op (no write, no storage event) when nothing changed, because the host
 * may retry the authorize on every focus.
 */
export async function rememberAllowedClient(
  senderId: string | undefined,
  client: { name?: string; version?: string } | undefined,
): Promise<void> {
  if (!senderId || !isExtensionId(senderId)) return;
  const details = sanitizeClient(client);
  if (!details.name && !details.version) return;

  try {
    await serialize(async () => {
      const settings = await storage.getAgentSettings();
      const existing = findAllowedClient(settings, senderId);
      if (!existing) return;
      if (
        (details.name ?? existing.name) === existing.name &&
        (details.version ?? existing.version) === existing.version
      ) {
        return;
      }
      await storage.setAgentSettings({
        ...settings,
        allowedClients: upsertAllowedClient(settings.allowedClients, {
          id: senderId,
          ...details,
        }),
      });
    });
  } catch (error) {
    console.warn('[Lumo Userscripts] Failed to refresh an allowlisted client:', error);
  }
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
