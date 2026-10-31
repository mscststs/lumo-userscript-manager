import { addAgentAudit, pruneAgentAudit } from '@/lib/db';
import { sha256Hex } from '@/lib/script/hash';

export interface AgentAuditInput {
  tool: string;
  senderId: string | undefined;
  args: unknown;
  targetUuid?: string;
  result: 'ok' | 'error';
  message?: string;
}

/**
 * Record one agent call.
 *
 * Arguments are hashed, never stored: a write carries the full script source,
 * which must not be duplicated into an audit table. Audit failures are logged
 * and swallowed so they can never turn a successful write into an error.
 */
export async function recordAgentAudit(input: AgentAuditInput): Promise<void> {
  try {
    const argsHash = await sha256Hex(JSON.stringify(input.args ?? {}));
    await addAgentAudit({
      time: Date.now(),
      tool: input.tool,
      senderId: input.senderId ?? '',
      argsHash,
      ...(input.targetUuid ? { targetUuid: input.targetUuid } : {}),
      result: input.result,
      ...(input.message ? { message: input.message.slice(0, 500) } : {}),
    });
    void pruneAgentAudit().catch(() => undefined);
  } catch (error) {
    console.warn('[Lumo Userscripts] Failed to write agent audit entry:', error);
  }
}
