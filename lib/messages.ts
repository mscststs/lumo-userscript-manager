import { appErrorFromResponse } from '@/lib/errors';

export interface BackgroundResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
  /** Stable user-facing failure code (see `lib/errors.ts`). */
  code?: string;
  params?: Record<string, unknown>;
}


export async function sendBg<T = unknown>(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const response = (await chrome.runtime.sendMessage({ type, payload })) as
    | BackgroundResponse<T>
    | undefined;
  if (!response?.ok) {
    throw appErrorFromResponse(response?.code, response?.error, response?.params);
  }
  return response.result as T;
}

export interface LumoEvent {
  type: 'lumo:event';
  event: string;
  payload: Record<string, unknown>;
}

export function onLumoEvent(listener: (event: string, payload: Record<string, unknown>) => void): () => void {
  const handler = (message: unknown) => {
    const data = message as LumoEvent;
    if (data?.type === 'lumo:event') listener(data.event, data.payload ?? {});
  };
  chrome.runtime.onMessage.addListener(handler);
  return () => chrome.runtime.onMessage.removeListener(handler);
}
