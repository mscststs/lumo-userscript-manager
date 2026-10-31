import type { AgentPendingRequest, AgentSettings } from '@/types';
import { storage } from '@/store/storage';
import { openOptionsTab } from '@/lib/options-tab';
import { isExtensionId } from './protocol';

/** Re-prompt at most once a day per extension. */
const PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A dismissed request can re-prompt after this long. */
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Do not steal focus more than once per 10s (multiple hosts may probe). */
const OPEN_COOLDOWN_MS = 10_000;

let lastOpenAt = 0;
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
 * Record an unknown caller as a pending approval request.
 *
 * Called from the probe handler, so it must never throw into the response.
 * Authorized callers and disabled endpoints are not recorded.
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
        // Expire a dismissal so a new prompt is possible after the cooldown.
        if (request.dismissedAt && now - request.dismissedAt >= DISMISS_COOLDOWN_MS) {
          delete request.dismissedAt;
        }
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
 * Open this extension's settings so the user can approve the request.
 *
 * Prompting is a convenience, not part of authorization: the probe still
 * answers `authorized:false` while this runs, and every failure is swallowed.
 */
export async function promptForRequest(request: AgentPendingRequest | undefined): Promise<void> {
  if (!request) return;
  try {
    const settings = await storage.getAgentSettings();
    if (!settings.promptOnRequest || request.dismissedAt) return;

    const now = Date.now();
    if (request.promptedAt && now - request.promptedAt < PROMPT_COOLDOWN_MS) return;
    if (now - lastOpenAt < OPEN_COOLDOWN_MS) return;

    // Mark before opening: if the tab call fails, we must not retry on every
    // probe from the same extension.
    await serialize(async () => {
      const requests = await storage.getAgentPendingRequests();
      await storage.setAgentPendingRequests(
        requests.map((entry) =>
          entry.id === request.id ? { ...entry, promptedAt: now } : entry,
        ),
      );
    });

    lastOpenAt = now;
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

/** Dismiss a request; it can re-prompt after the cooldown. */
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
