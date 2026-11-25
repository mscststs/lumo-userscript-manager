import {
  OFFSCREEN_PORT,
  type OffscreenClipboardRequest,
  type OffscreenReplyMessage,
  type OffscreenRequestMessage,
  type OffscreenXhrRequest,
} from '@/lib/offscreen/protocol';
import { runXhr, type XhrHandle } from '@/lib/offscreen/xhr';

/**
 * Offscreen document: the only place in the extension with a DOM.
 *
 * It runs GM requests with the native `XMLHttpRequest` (so `readyState`,
 * `responseXML`, upload progress and `overrideMimeType` behave exactly like a
 * page XHR) and performs clipboard writes, which need a focused document.
 */

const active = new Map<string, XhrHandle>();

function reply(port: chrome.runtime.Port, message: OffscreenReplyMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // The worker went away; the request is already tracked by `active`.
  }
}

function replyError(port: chrome.runtime.Port, id: string, error: unknown): void {
  reply(port, { id, error: error instanceof Error ? error.message : String(error) });
}

async function setClipboard(request: OffscreenClipboardRequest): Promise<void> {
  const { data, mime } = request;
  if (mime !== 'text/plain' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ [mime]: new Blob([data], { type: mime }) }),
      ]);
      return;
    } catch {
      // Fall through to the text paths below.
    }
  }
  try {
    await navigator.clipboard.writeText(data);
    return;
  } catch {
    // Clipboard API needs focus; the textarea path still works in an offscreen
    // document because the document itself can be focused.
  }
  const textarea = document.createElement('textarea');
  textarea.value = data;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('The clipboard is not writable.');
}

async function handle(
  port: chrome.runtime.Port,
  message: OffscreenRequestMessage,
): Promise<unknown> {
  switch (message.cmd) {
    case 'XHRStart': {
      const request = message.data as OffscreenXhrRequest;
      const handle = runXhr(request, (event) => reply(port, { id: message.id, event }));
      active.set(request.id, handle);
      try {
        return await handle.promise;
      } finally {
        active.delete(request.id);
      }
    }
    case 'XHRStop': {
      const { id } = message.data as { id: string };
      active.get(id)?.abort();
      return undefined;
    }
    case 'ClipboardSet':
      return setClipboard(message.data as OffscreenClipboardRequest);
    default:
      throw new Error(`Unknown offscreen command: ${String(message.cmd)}`);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== OFFSCREEN_PORT) return;
  port.onMessage.addListener((message: OffscreenRequestMessage) => {
    if (!message || typeof message.id !== 'string') return;
    void handle(port, message).then(
      (result) => reply(port, { id: message.id, result }),
      (error) => replyError(port, message.id, error),
    );
  });
});
