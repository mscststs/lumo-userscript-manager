/**
 * Wire contract between the agent host (Lumo) and this extension.
 *
 * There are exactly two layers:
 *
 *   L0  probe   — one stateless message over `chrome.runtime.sendMessage`.
 *                 Answers "are you there, may I connect, are you ready".
 *   L1  MCP     — standard Model Context Protocol over a `chrome.runtime` Port.
 *                 The manager implements it with the official SDK, so this file
 *                 deliberately contains no JSON-RPC or tool definitions.
 *
 * Keeping L0 separate is what makes the "installed but disabled / not
 * authorized" state expressible: an MCP `initialize` cannot describe it without
 * failing the handshake.
 */

export const PROBE_CHANNEL = 'lumo:probe' as const;
export const PROBE_VERSION = 1;

/** Port name the host uses to open the MCP session. */
export const MCP_PORT_NAME = 'lumo:mcp';

/** Short machine-safe service name used by the host for tool namespacing. */
export const AGENT_NAMESPACE = 'userscripts';
export const AGENT_SERVICE_NAME = 'Lumo Userscripts';

export interface AgentClientInfo {
  id: string;
  name: string;
  version: string;
}

export interface ProbeRequest {
  channel: typeof PROBE_CHANNEL;
  version: number;
  /** Request id, echoed for diagnostics. */
  id?: string;
  client?: AgentClientInfo;
}

export interface AgentServiceInfo {
  namespace: string;
  name: string;
  version: string;
}

export interface AgentStatus {
  /** The user's master switch for the agent endpoint. */
  enabled: boolean;
  /** Whether the calling extension is on the allowlist. */
  authorized: boolean;
  /** Whether the capability the host wants to use is actually available. */
  ready: boolean;
  /** An approval request is waiting for the user in this extension's settings. */
  pendingApproval?: boolean;
  reason?: { code: string; message: string };
}

export type ProbeErrorCode = 'UNSUPPORTED_PROTOCOL' | 'INTERNAL';

export interface ProbeResponse {
  ok: boolean;
  service?: AgentServiceInfo;
  status?: AgentStatus;
  error?: { code: ProbeErrorCode; message: string };
}

/** Chrome extension IDs are 32 characters drawn from `a`–`p`. */
export function isExtensionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}

/**
 * Validate an untrusted `onMessageExternal` payload.
 *
 * `channel` is a fixed string and `version` must be a finite number; everything
 * else is optional so a newer host can add fields without breaking this build.
 */
export function isProbeRequest(value: unknown): value is ProbeRequest {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return data.channel === PROBE_CHANNEL && typeof data.version === 'number';
}
