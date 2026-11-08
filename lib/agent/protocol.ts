/**
 * Wire contract between the agent host (Lumo) and this extension.
 *
 * Two layers, and exactly two L0 messages:
 *
 *   L0  probe     — `lumo:probe`. Read-only. Answers "are you there, and would
 *                   you accept me": service metadata plus status. Never writes,
 *                   never opens anything, so it is safe to send as often as a
 *                   host likes — including a catalog scan over extensions that
 *                   nobody has added yet.
 *   L0  authorize — `lumo:authorize`. The user asked to use this extension from
 *                   the host. Records the request and prompts the user here, in
 *                   this extension's own settings. This is the only message with
 *                   side effects, and the only one allowed to steal focus.
 *   L1  MCP       — standard Model Context Protocol over a `chrome.runtime` Port
 *                   named `lumo:mcp`.
 *
 * Why the split: a probe that also recorded approvals was neither safe to repeat
 * nor safe to call from a background retry — it queued writes, opened tabs, and
 * made the answer depend on history ("probed before, so…"). Read and act are two
 * different questions; they are now two different messages.
 *
 * `PROBE_VERSION` stays `1`: both changes are additive on the wire (no field was
 * repurposed), so a v1 host and a v1 provider keep interoperating — an older
 * provider simply has no `lumo:authorize` listener.
 */

export const PROBE_CHANNEL = 'lumo:probe' as const;
export const AUTHORIZE_CHANNEL = 'lumo:authorize' as const;
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

/** `lumo:probe` payload. Anything optional is display-only. */
export interface ProbeRequest {
  channel: typeof PROBE_CHANNEL;
  version: number;
  /** Request id, echoed for diagnostics. */
  id?: string;
  client?: AgentClientInfo;
}

/** `lumo:authorize` payload: who is asking, so the prompt can name the host. */
export interface AuthorizeRequest {
  channel: typeof AUTHORIZE_CHANNEL;
  version: number;
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
  reason?: { code: string; message: string };
}

/**
 * Reply shape for both L0 messages.
 *
 * One type on purpose: the host's parser, error handling and status mapping are
 * then shared, and a provider cannot accidentally answer `authorize` with a
 * shape the host does not understand.
 */
export interface ProbeResponse {
  ok: boolean;
  service?: AgentServiceInfo;
  status?: AgentStatus;
  error?: { code: ProbeErrorCode; message: string };
}

export type ProbeErrorCode =
  /** The caller speaks a protocol version this build does not. */
  | 'UNSUPPORTED_PROTOCOL'
  /** The user turned "open settings when an extension asks" off: this extension
   *  does not participate in host discovery or approval at all. */
  | 'REQUESTS_DISABLED'
  /** Anything that escaped a handler. */
  | 'INTERNAL';

/** Browser extension IDs are 32 characters drawn from `a`–`p`. */
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

export function isAuthorizeRequest(value: unknown): value is AuthorizeRequest {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return data.channel === AUTHORIZE_CHANNEL && typeof data.version === 'number';
}
