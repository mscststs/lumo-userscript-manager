import {
  OFFSCREEN_PORT,
  type OffscreenCommand,
  type OffscreenReplyMessage,
  type OffscreenRequestMessage,
  type OffscreenXhrEvent,
} from '@/lib/offscreen/protocol';

/**
 * Service-worker side of the offscreen bridge.
 *
 * The worker owns the request lifecycle (timeout, abort, DNR rule cleanup) while
 * the offscreen document owns the DOM/XHR. Only one offscreen document can
 * exist per extension, so its creation is shared through a single promise and
 * every caller reuses the same long-lived port.
 */

const OFFSCREEN_PATH = 'offscreen.html';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onEvent?: (event: OffscreenXhrEvent) => void;
}

let documentPromise: Promise<void> | null = null;
let portPromise: Promise<chrome.runtime.Port> | null = null;
let callSequence = 0;
const pending = new Map<string, PendingCall>();

function offscreenApi(): typeof chrome.offscreen | null {
  return chrome.offscreen ?? null;
}

export function isOffscreenSupported(): boolean {
  return Boolean(offscreenApi()?.createDocument);
}

async function ensureDocument(): Promise<void> {
  const api = offscreenApi();
  if (!api) throw new Error('The offscreen API is not available in this browser.');
  const existing = await api.hasDocument?.().catch(() => false);
  if (existing) return;
  documentPromise ??= api
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS', 'BLOBS', 'CLIPBOARD'],
      justification:
        'Userscript GM requests need a DOM XMLHttpRequest (events, responseXML, upload progress) and clipboard writes.',
    })
    .catch((error: unknown) => {
      // Another caller (or a previous worker instance) may have won the race.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Only a single offscreen')) throw error;
    })
    .finally(() => {
      documentPromise = null;
    });
  await documentPromise;
}

function rejectAll(error: Error): void {
  for (const [id, entry] of pending) {
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(error);
  }
}

function handleMessage(message: OffscreenReplyMessage): void {
  const entry = pending.get(message.id);
  if (!entry) return;
  if (message.event) {
    try {
      entry.onEvent?.(message.event);
    } catch {
      // A listener failure must not break the request.
    }
    return;
  }
  pending.delete(message.id);
  if (entry.timer) clearTimeout(entry.timer);
  if (message.error !== undefined) entry.reject(new Error(message.error));
  else entry.resolve(message.result);
}

function connect(): Promise<chrome.runtime.Port> {
  portPromise ??= (async () => {
    await ensureDocument();
    const port = chrome.runtime.connect({ name: OFFSCREEN_PORT });
    port.onMessage.addListener((message: OffscreenReplyMessage) => handleMessage(message));
    port.onDisconnect.addListener(() => {
      portPromise = null;
      rejectAll(new Error('The offscreen document disconnected.'));
    });
    return port;
  })().catch((error) => {
    portPromise = null;
    throw error;
  });
  return portPromise;
}

/** Call a command in the offscreen document; events stream through `onEvent`. */
export async function callOffscreen<T>(
  cmd: OffscreenCommand,
  data: unknown,
  options: { timeoutMs?: number; onEvent?: (event: OffscreenXhrEvent) => void } = {},
): Promise<T> {
  const port = await connect();
  const id = `off-${Date.now()}-${++callSequence}`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise<T>((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(id);
            reject(new Error('The offscreen document did not answer in time.'));
          }, timeoutMs)
        : null;
    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
      onEvent: options.onEvent,
    });
    const message: OffscreenRequestMessage = { id, cmd, data };
    try {
      port.postMessage(message);
    } catch (error) {
      pending.delete(id);
      if (timer) clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Fire-and-forget abort; the request resolves through its own promise. */
export function stopOffscreenXhr(id: string): void {
  void callOffscreen('XHRStop', { id }, { timeoutMs: 5_000 }).catch(() => undefined);
}

export async function writeClipboard(data: string, mime: string): Promise<void> {
  await callOffscreen('ClipboardSet', { data, mime }, { timeoutMs: 10_000 });
}
