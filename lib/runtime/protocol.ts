import type { RuntimeScriptPayload } from '@/types';

export const HANDSHAKE = 'lumo-us:handshake';
export const RUNNER_READY = 'lumo-us:runner-ready';

export interface PageRpcRequest {
  __lumo: 'rpc';
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface PageRpcResponse {
  __lumo: 'rpc-result';
  id: string;
  result?: unknown;
  error?: string;
}

export interface PageEvent {
  __lumo: 'event';
  event:
    | 'value-changed'
    | 'menu-command'
    | 'notification-click'
    | 'notification-close'
    | 'xhr-progress'
    | 'download-progress'
    | 'download-result'
    | 'open-tab-closed';
  payload: Record<string, unknown>;
}

export type PageMessage = PageRpcRequest | PageRpcResponse | PageEvent;

export interface RunnerApi {
  run: (payload: RuntimeScriptPayload) => void;
}

export interface HostApi {
  run: (payload: RuntimeScriptPayload) => void;
}
