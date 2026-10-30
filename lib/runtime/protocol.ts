import type { RuntimeResource, RuntimeScriptPayload } from '@/types';

/**
 * Transport contract shared by every runtime layer.
 *
 * There are exactly three links in the chain:
 *
 *   userscript engine (MAIN or USER_SCRIPT world)
 *     -> window MessageChannel (this protocol)
 *       -> content-script bridge (ISOLATED world)
 *         -> chrome.runtime messaging
 *           -> background service worker
 *
 * The contract deliberately contains no `chrome.*` or DOM references so it can
 * be bundled into the two IIFE engines, the content script and the service
 * worker without pulling in an environment-specific dependency.
 */

export const BRIDGE_HELLO = 'lumo:bridge-hello';
export const BRIDGE_READY = 'lumo:bridge-ready';
export const BRIDGE_RPC = 'lumo:bridge-rpc';
export const BRIDGE_RESULT = 'lumo:bridge-result';
export const BRIDGE_EVENT = 'lumo:bridge-event';
export const BRIDGE_RESUME = 'lumo:bridge-resume';

/** Engine identity used only for diagnostics and multi-client bookkeeping. */
export type BridgeClientKind = 'main' | 'userscript';

export interface BridgeHello {
  __lumo: typeof BRIDGE_HELLO;
  nonce: string;
  clientId: string;
  kind: BridgeClientKind;
}

export interface BridgeReady {
  __lumo: typeof BRIDGE_READY;
  nonce: string;
  bridgeId: string;
}

export interface BridgeRpc {
  __lumo: typeof BRIDGE_RPC;
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface BridgeResult {
  __lumo: typeof BRIDGE_RESULT;
  id: string;
  result?: unknown;
  error?: string;
  code?: string;
}

export interface BridgeEvent {
  __lumo: typeof BRIDGE_EVENT;
  event: RuntimeEventName;
  payload: Record<string, unknown>;
}

export interface BridgeResume {
  __lumo: typeof BRIDGE_RESUME;
}

export type BridgeMessage =
  | BridgeHello
  | BridgeReady
  | BridgeRpc
  | BridgeResult
  | BridgeEvent
  | BridgeResume;

/**
 * Background RPC envelope. Every response is `ok`-tagged so a transport error
 * and a domain error can be distinguished without parsing Chrome strings.
 */
export interface HostResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  code?: HostErrorCode;
}

export type HostErrorCode =
  | 'BAD_REQUEST'
  | 'INVALID_TOKEN'
  | 'SCRIPT_NOT_ACTIVE'
  | 'NOT_MATCHED'
  | 'UNSUPPORTED'
  | 'HOST_FAILED'
  | 'BACKGROUND_UNAVAILABLE'
  | 'BRIDGE_UNAVAILABLE'
  | 'RPC_TIMEOUT';

/** Requests the content-script bridge is allowed to forward to the worker. */
export const HOST_RPC_TYPES = new Set([
  'host:bootstrap',
  'host:gm',
  'host:value:set',
  'host:value:delete',
  'host:run',
  'host:log',
  'host:menu:register',
  'host:menu:unregister',
]);

export type RuntimeEventName =
  | 'value-changed'
  | 'menu-command'
  | 'notification-click'
  | 'notification-close'
  | 'xhr-progress'
  | 'download-progress'
  | 'download-result'
  | 'open-tab-closed';

export interface RuntimeBootstrapResult {
  storageName?: string;
  values: Record<string, unknown>;
  resources: Record<string, RuntimeResource>;
}

export interface EngineGlobal {
  run: (payload: RuntimeScriptPayload) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __LUMO_RUNNER__: EngineGlobal | undefined;
  // eslint-disable-next-line no-var
  var __LUMO_RUNNER_QUEUE__: RuntimeScriptPayload[] | undefined;
  // eslint-disable-next-line no-var
  var __LUMO_HOST__: EngineGlobal | undefined;
  // eslint-disable-next-line no-var
  var __LUMO_HOST_QUEUE__: RuntimeScriptPayload[] | undefined;
}

/** Narrow helpers so callers never trust a partially-shaped message. */
export function isBridgeHello(value: unknown): value is BridgeHello {
  const data = value as Partial<BridgeHello> | null;
  return Boolean(data && data.__lumo === BRIDGE_HELLO && typeof data.nonce === 'string');
}

export function isBridgeRpc(value: unknown): value is BridgeRpc {
  const data = value as Partial<BridgeRpc> | null;
  return Boolean(
    data &&
      data.__lumo === BRIDGE_RPC &&
      typeof data.id === 'string' &&
      typeof data.type === 'string' &&
      data.payload !== null &&
      typeof data.payload === 'object',
  );
}

export function isBridgeResult(value: unknown): value is BridgeResult {
  return Boolean((value as Partial<BridgeResult> | null)?.__lumo === BRIDGE_RESULT);
}

export function isBridgeEvent(value: unknown): value is BridgeEvent {
  return Boolean((value as Partial<BridgeEvent> | null)?.__lumo === BRIDGE_EVENT);
}
