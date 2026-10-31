import type { AgentSettings } from '@/types';
import { storage } from '@/store/storage';

export interface AgentAccess {
  settings: AgentSettings;
  enabled: boolean;
  authorized: boolean;
}

/**
 * Resolve the agent endpoint policy for one caller.
 *
 * `enabled` and `authorized` stay separate because the host renders different
 * states for them: "turn it on" vs "allow this extension". Both must be true
 * before a single MCP message is accepted.
 */
export async function resolveAgentAccess(senderId: string | undefined): Promise<AgentAccess> {
  const settings = await storage.getAgentSettings();
  return {
    settings,
    enabled: settings.enabled,
    authorized: Boolean(senderId && settings.allowedExtensionIds.includes(senderId)),
  };
}

export async function isSenderAllowed(senderId: string | undefined): Promise<boolean> {
  const access = await resolveAgentAccess(senderId);
  return access.enabled && access.authorized;
}
