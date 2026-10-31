import type { AgentPendingRequest } from '@/types';

/**
 * How long after `promptForRequest` wrote `promptedAt` a request still counts
 * as "just announced". Opening the options page because of a probe is the only
 * case where a page load should interrupt the user; a manual visit to an old
 * queue must not.
 */
export const PROMPT_FRESH_MS = 60_000;

export interface AgentPromptGate {
  /** Queue head: the background keeps the newest request first. */
  request: AgentPendingRequest | undefined;
  settings: { promptOnRequest: boolean } | null | undefined;
  now: number;
  /** The dialog is already visible; there is nothing to decide. */
  open: boolean;
  /**
   * The dialog already interrupted once in this session. Remaining queue items
   * then follow it in without having to be "fresh" again.
   */
  engaged: boolean;
  /** Requests the user pushed aside for this session only. */
  deferred: ReadonlySet<string>;
}

/**
 * Whether the approval dialog should surface on its own.
 *
 * Kept pure so the interrupt policy can be tested without a DOM: the dialog
 * must never steal focus for a request the user already pushed aside, and it
 * must respect the "prompt on request" switch — with prompting off, pending
 * requests stay visible in Settings → Agent only.
 */
export function shouldOpenAgentPrompt(gate: AgentPromptGate): boolean {
  const { request, settings, now, open, engaged, deferred } = gate;
  if (!request || open) return false;
  if (deferred.has(request.id)) return false;
  if (!settings?.promptOnRequest) return false;
  if (engaged) return true;
  return request.promptedAt !== undefined && now - request.promptedAt < PROMPT_FRESH_MS;
}
