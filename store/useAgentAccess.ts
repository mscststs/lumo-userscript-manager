import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentPendingRequest, AgentSettings } from '@/types';
import { sendBg } from '@/lib/messages';
import { storage } from './storage';
import { useStorageWatch } from './useStorageWatch';

export interface AgentAccess {
  /** Current agent endpoint settings, or null until the first read lands. */
  settings: AgentSettings | null;
  requests: AgentPendingRequest[];
  /** Requests still waiting for a decision, newest first. */
  actionable: AgentPendingRequest[];
  /** Allow a caller. Rejects when the background refuses the write. */
  approve: (id: string) => Promise<void>;
  /** Suppress a caller for the dismissal cooldown. */
  dismiss: (id: string) => Promise<void>;
}

/**
 * Pending agent access requests, shared by the inline settings list and the
 * global approval dialog.
 *
 * The background owns the queue: it records probes and it is the only writer
 * for approvals. This hook therefore reads that storage key and re-reads it on
 * every change (`chrome.storage.onChanged`) instead of keeping a second source
 * of truth; the optimistic updates below only shorten the round trip.
 */
export function useAgentAccess(): AgentAccess {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [requests, setRequests] = useState<AgentPendingRequest[]>([]);

  useEffect(() => {
    storage
      .getAgentSettings()
      .then(setSettings)
      .catch(() => undefined);
    storage
      .getAgentPendingRequests()
      .then(setRequests)
      .catch(() => undefined);
  }, []);

  useStorageWatch<AgentSettings>('agentSettings', (next) => {
    if (next) setSettings(next);
  });

  useStorageWatch<AgentPendingRequest[]>('agentPendingRequests', (next) => {
    setRequests(next ?? []);
  });

  const approve = useCallback(async (id: string) => {
    await sendBg('agent:approveRequest', { id });
    setRequests((prev) => prev.filter((request) => request.id !== id));
  }, []);

  const dismiss = useCallback(async (id: string) => {
    await sendBg('agent:dismissRequest', { id });
    setRequests((prev) =>
      prev.map((request) =>
        request.id === id ? { ...request, dismissedAt: Date.now() } : request,
      ),
    );
  }, []);

  const actionable = useMemo(
    () => requests.filter((request) => !request.dismissedAt),
    [requests],
  );

  return { settings, requests, actionable, approve, dismiss };
}
