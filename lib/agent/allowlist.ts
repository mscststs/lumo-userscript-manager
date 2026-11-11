import type { AgentAllowedClient, AgentSettings } from '@/types';

/**
 * Pure allowlist operations for the agent endpoint.
 *
 * The ID is the identity; everything else is a display hint the caller reports
 * about itself. Keeping these helpers pure means the probe, the authorize
 * handler, the settings writer and the schema normalizer all apply the same
 * dedupe/cap/merge rules instead of each re-implementing them.
 */

/** `chrome.storage.local` holds the allowlist, so it must stay bounded. */
export const MAX_ALLOWED_CLIENTS = 16;

export function findAllowedClient(
  settings: Pick<AgentSettings, 'allowedClients'>,
  id: string | undefined,
): AgentAllowedClient | undefined {
  if (!id) return undefined;
  return settings.allowedClients.find((client) => client.id === id);
}

export function isAllowedClient(
  settings: Pick<AgentSettings, 'allowedClients'>,
  id: string | undefined,
): boolean {
  return Boolean(findAllowedClient(settings, id));
}

/**
 * Add a client, or refresh the details of one that is already allowed.
 *
 * An existing row keeps its position (the list is a stable consent record, not
 * a feed); omitted details never erase what is already known, so a host that
 * only reports its name cannot wipe a version learned earlier. New rows go to
 * the front, matching the newest-first pending queue and making a just-added
 * entry the first thing the user sees.
 */
export function upsertAllowedClient(
  clients: readonly AgentAllowedClient[],
  client: AgentAllowedClient,
): AgentAllowedClient[] {
  const existing = clients.find((entry) => entry.id === client.id);
  if (!existing) {
    return [client, ...clients].slice(0, MAX_ALLOWED_CLIENTS);
  }

  const name = client.name ?? existing.name;
  const version = client.version ?? existing.version;
  const merged: AgentAllowedClient = {
    id: existing.id,
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
  };

  return clients.map((entry) => (entry.id === client.id ? merged : entry));
}

export function removeAllowedClient(
  clients: readonly AgentAllowedClient[],
  id: string,
): AgentAllowedClient[] {
  return clients.filter((client) => client.id !== id);
}
