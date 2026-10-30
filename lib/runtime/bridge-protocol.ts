/** Handshake and message contract between a userscript-world Host and the
 * normal content-script extension bridge. Keeping this separate from the
 * page bridge makes the transport layer replaceable and testable. */
export const BRIDGE_HELLO = 'lumo-us:bridge-hello';
export const BRIDGE_READY = 'lumo-us:bridge-ready';
export const BRIDGE_RPC = 'lumo-us:bridge-rpc';
export const BRIDGE_RESULT = 'lumo-us:bridge-result';
export const BRIDGE_EVENT = 'lumo-us:bridge-event';

export interface BridgeRpc {
  __lumoBridge: typeof BRIDGE_RPC;
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface BridgeResult {
  __lumoBridge: typeof BRIDGE_RESULT;
  id: string;
  result?: unknown;
  error?: string;
}

export interface BridgeEvent {
  __lumoBridge: typeof BRIDGE_EVENT;
  event: string;
  payload: Record<string, unknown>;
}
