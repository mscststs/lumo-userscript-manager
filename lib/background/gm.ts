import type { UserScript } from '@/types';
import { getScript } from '@/lib/db';
import { mergeMetadata } from '@/lib/script/metadata';
import { sendToHost } from './host-ports';
import { recordLog } from './logs';

export interface GmRequestContext {
  tabId: number;
  frameId: number;
  url: string;
  uuid: string;
}

const xhrControllers = new Map<string, AbortController>();
const tabState = new Map<string, Map<number, unknown>>();
const notificationTargets = new Map<string, GmRequestContext>();
const notificationDetails = new Map<string, Record<string, unknown>>();
const downloadTargets = new Map<number, { requestId: string; ctx: GmRequestContext }>();
const downloadRequests = new Map<string, { downloadId: number; ctx: GmRequestContext }>();
const openTabTargets = new Map<number, GmRequestContext>();

function hostMatches(entry: string, hostname: string): boolean {
  const value = entry.trim().toLowerCase();
  if (!value) return false;
  if (value === '*') return true;
  if (value.startsWith('*.')) {
    const suffix = value.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  if (value.startsWith('.')) {
    const suffix = value.slice(1);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === value || hostname.endsWith(`.${value}`);
}

export function canConnect(script: UserScript, url: string, pageUrl?: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol === 'blob:' || target.protocol === 'data:') return true;
  try {
    const pageHost = pageUrl ? new URL(pageUrl).hostname : '';
    if (pageHost && target.hostname === pageHost) return true;
    if (pageHost && (script.connect ?? []).some((entry) => entry.trim() === 'self')) {
      return target.hostname === pageHost;
    }
  } catch {
    // The page URL may be unavailable in a detached frame; fall through.
  }
  if (target.hostname === new URL(script.origin || 'https://invalid').hostname) return true;
  return (script.connect ?? []).some((entry) => hostMatches(entry, target.hostname));
}

function requireConnect(
  script: UserScript,
  url: string,
  api: string,
  pageUrl?: string,
): void {
  if (!canConnect(script, url, pageUrl)) {
    throw new Error(
      `${api}: ${new URL(url).hostname} is not permitted. Add it to @connect and reinstall the script.`,
    );
  }
}

function base64FromBuffer(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function handleXhr(
  script: UserScript,
  args: unknown[],
  pageUrl: string | undefined,
  ctx: GmRequestContext,
): Promise<unknown> {
  const options = (args[0] ?? {}) as Record<string, any>;
  const url = new URL(String(options.url ?? ''), pageUrl || undefined).toString();
  requireConnect(script, url, 'GM_xmlhttpRequest', pageUrl);
  const controller = new AbortController();
  const requestId = String(options.requestId ?? crypto.randomUUID());
  xhrControllers.set(requestId, controller);
  const timeout = Number(options.timeout) || 0;
  const timer = timeout ? setTimeout(() => controller.abort('timeout'), timeout) : null;

  try {
    const response = await fetch(url, {
      method: String(options.method ?? 'GET'),
      headers: options.headers ?? undefined,
      body:
        options.data && typeof options.data === 'object'
          ? JSON.stringify(options.data)
          : (options.data ?? undefined),
      credentials: options.anonymous ? 'omit' : 'include',
      redirect: 'follow',
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const responseType = String(options.responseType ?? 'text');
    const contentType = response.headers.get('content-type') ?? '';
    const total = Number(response.headers.get('content-length') ?? 0) || 0;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          loaded += value.byteLength;
          sendToHost(ctx.tabId, ctx.frameId, {
            type: 'bg:event',
            event: 'xhr-progress',
            payload: { uuid: ctx.uuid, requestId, loaded, total },
          });
        }
      }
    }
    let merged: Uint8Array;
    if (chunks.length === 0) {
      merged = reader ? new Uint8Array(0) : new Uint8Array(await response.arrayBuffer());
    } else {
      merged = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    const buffer = merged.buffer;
    const text = new TextDecoder().decode(buffer);
    const base = {
      status: response.status,
      statusText: response.statusText,
      responseHeaders: Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n'),
      finalUrl: response.url,
      contentType,
      readyState: 4,
    };
    if (responseType === 'json') {
      return { ...base, response: text ? JSON.parse(text) : null, responseText: text };
    }
    if (responseType === 'arraybuffer') {
      return { ...base, responseBase64: base64FromBuffer(buffer), responseText: text };
    }
    if (responseType === 'blob') {
      return { ...base, responseBase64: base64FromBuffer(buffer), contentType, responseText: text };
    }
    return { ...base, response: text, responseText: text };
  } catch (error) {
    if (controller.signal.reason === 'timeout') {
      throw new Error('GM_xmlhttpRequest timeout');
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    xhrControllers.delete(requestId);
  }
}

async function handleCookie(script: UserScript, args: unknown[], pageUrl?: string): Promise<unknown> {
  const action = String(args[0] ?? 'list');
  const details = (args[1] ?? {}) as Record<string, any>;
  const target = details.url || `https://${details.domain || ''}${details.path || '/'}`;
  requireConnect(script, target, 'GM_cookie', pageUrl);
  switch (action) {
    case 'list':
      return chrome.cookies.getAll(details as chrome.cookies.GetAllDetails);
    case 'set':
      return chrome.cookies.set({
        ...details,
        url: details.url ?? `https://${details.domain}${details.path || '/'}`,
      } as chrome.cookies.SetDetails);
    case 'delete':
      return chrome.cookies.remove({
        name: details.name,
        url: details.url ?? `https://${details.domain}${details.path || '/'}`,
      });
    default:
      throw new Error(`Unknown GM_cookie action: ${action}`);
  }
}

async function handleNotification(ctx: GmRequestContext, args: unknown[]): Promise<unknown> {
  const details = (args[0] ?? {}) as Record<string, any>;
  const id = String(details.id ?? crypto.randomUUID());
  notificationTargets.set(id, ctx);
  notificationDetails.set(id, details);
  let iconUrl = chrome.runtime.getURL('icon/128.png');
  if (details.image) {
    try {
      iconUrl = new URL(String(details.image), ctx.url || undefined).toString();
    } catch {
      // keep the extension icon
    }
  }
  const buttons = Array.isArray(details.buttons)
    ? details.buttons
        .slice(0, 2)
        .map((button: unknown) =>
          typeof button === 'string'
            ? { title: button }
            : { title: String((button as Record<string, unknown>)?.title ?? '') },
        )
        .filter((button: { title: string }) => button.title)
    : undefined;
  const options: chrome.notifications.NotificationCreateOptions = {
    type: 'basic',
    iconUrl,
    title: String(details.title ?? 'Lumo Userscripts'),
    message: String(details.text ?? details.message ?? ''),
    contextMessage: details.contextMessage,
    silent: Boolean(details.silent),
    requireInteraction: Boolean(details.requireInteraction),
    buttons,
  };
  await chrome.notifications.create(id, options);
  return id;
}

function downloadPayload(
  downloadId: number,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: downloadId,
    url: details.url,
    filename: details.filename,
    finalUrl: details.finalUrl,
    fileSize: details.fileSize,
  };
}

export function onDownloadChanged(downloadId: number, delta: chrome.downloads.DownloadDelta): void {
  const target = downloadTargets.get(downloadId);
  if (!target) return;
  const terminal = delta.state?.current;
  void chrome.downloads.search({ id: downloadId }).then((items) => {
    const item = items[0];
    if (!item) return;
    if (!terminal || terminal === 'in_progress') {
      sendToHost(target.ctx.tabId, target.ctx.frameId, {
        type: 'bg:event',
        event: 'download-progress',
        payload: {
          uuid: target.ctx.uuid,
          requestId: target.requestId,
          loaded: item.bytesReceived,
          total: item.totalBytes > 0 ? item.totalBytes : 0,
        },
      });
      return;
    }
    downloadTargets.delete(downloadId);
    downloadRequests.delete(target.requestId);
    if (terminal === 'complete') {
      sendToHost(target.ctx.tabId, target.ctx.frameId, {
        type: 'bg:event',
        event: 'download-result',
        payload: {
          uuid: target.ctx.uuid,
          requestId: target.requestId,
          result: downloadPayload(downloadId, item as unknown as Record<string, unknown>),
        },
      });
    } else {
      const error = delta.error?.current ?? item.error ?? 'Download interrupted.';
      sendToHost(target.ctx.tabId, target.ctx.frameId, {
        type: 'bg:event',
        event: 'download-result',
        payload: {
          uuid: target.ctx.uuid,
          requestId: target.requestId,
          result: { ...downloadPayload(downloadId, item as unknown as Record<string, unknown>), error },
          error,
        },
      });
    }
  });
}

export function onTabRemoved(tabId: number): void {
  for (const map of tabState.values()) map.delete(tabId);
  const target = openTabTargets.get(tabId);
  if (!target) return;
  openTabTargets.delete(tabId);
  sendToHost(target.tabId, target.frameId, {
    type: 'bg:event',
    event: 'open-tab-closed',
    payload: { uuid: target.uuid, tabId },
  });
}

export async function handleGmApi(
  api: string,
  args: unknown[],
  ctx: GmRequestContext,
): Promise<unknown> {
  const stored = await getScript(ctx.uuid);
  if (!stored || !stored.enabled || stored.removedAt) {
    throw new Error('Script is not active.');
  }
  const effective = mergeMetadata(stored.metadata, stored.selfMetadata);
  const script = { ...stored, connect: effective.connect ?? [] };

  switch (api) {
    case 'GM_xmlhttpRequest':
      return handleXhr(script, args, ctx.url, ctx);
    case 'GM_xmlhttpRequestAbort': {
      const requestId = String(args[0] ?? '');
      xhrControllers.get(requestId)?.abort();
      return undefined;
    }
    case 'GM_cookie':
      return handleCookie(script, args, ctx.url);
    case 'GM_download': {
      const details = (args[0] ?? {}) as Record<string, any>;
      const requestId = String(details.requestId ?? crypto.randomUUID());
      const target = new URL(String(details.url ?? ''), ctx.url || undefined).toString();
      requireConnect(script, target, 'GM_download', ctx.url);
      try {
        const id = await chrome.downloads.download({
          url: target,
          filename: details.name,
          saveAs: Boolean(details.saveAs),
          conflictAction: details.conflictAction,
        });
        downloadTargets.set(id, { requestId, ctx });
        downloadRequests.set(requestId, { downloadId: id, ctx });
        void chrome.downloads.search({ id }).then((items) => {
          const item = items[0];
          if (!item) return;
          sendToHost(ctx.tabId, ctx.frameId, {
            type: 'bg:event',
            event: 'download-progress',
            payload: {
              uuid: ctx.uuid,
              requestId,
              loaded: item.bytesReceived,
              total: item.totalBytes > 0 ? item.totalBytes : 0,
            },
          });
        });
        return { id, requestId };
      } catch (error) {
        downloadRequests.delete(requestId);
        throw error;
      }
    }
    case 'GM_downloadAbort': {
      const requestId = String(args[0] ?? '');
      const target = downloadRequests.get(requestId);
      if (target) {
        downloadRequests.delete(requestId);
        downloadTargets.delete(target.downloadId);
        await chrome.downloads.cancel(target.downloadId).catch(() => undefined);
      }
      return undefined;
    }
    case 'GM_notification':
      return handleNotification(ctx, args);
    case 'GM_closeNotification': {
      const id = String(args[0] ?? '');
      const target = notificationTargets.get(id);
      if (target) {
        sendToHost(target.tabId, target.frameId, {
          type: 'bg:event',
          event: 'notification-close',
          payload: { uuid: target.uuid, id, byUser: false },
        });
      }
      notificationTargets.delete(id);
      notificationDetails.delete(id);
      await chrome.notifications.clear(id);
      return undefined;
    }
    case 'GM_updateNotification': {
      const [id, details] = args as [string, Record<string, unknown>];
      notificationDetails.set(
        String(id),
        { ...(notificationDetails.get(String(id)) ?? {}), ...details },
      );
      await chrome.notifications.update(String(id), details as chrome.notifications.NotificationOptions);
      return undefined;
    }
    case 'GM_openInTab': {
      const [url, options = {}] = args as [string, Record<string, any>];
      const target = new URL(url, ctx.url || undefined).toString();
      const tab = await chrome.tabs.create({ url: target, active: Boolean(options.active) });
      if (tab.id !== undefined) openTabTargets.set(tab.id, ctx);
      return tab;
    }
    case 'GM_closeInTab': {
      const tabId = Number(args[0]);
      if (Number.isFinite(tabId)) await chrome.tabs.remove(tabId);
      return undefined;
    }
    case 'GM_getTab': {
      return tabState.get(ctx.uuid)?.get(ctx.tabId);
    }
    case 'GM_saveTab': {
      const map = tabState.get(ctx.uuid) ?? new Map<number, unknown>();
      map.set(ctx.tabId, args[0]);
      tabState.set(ctx.uuid, map);
      return undefined;
    }
    case 'GM_getTabs': {
      const map = tabState.get(ctx.uuid);
      return map ? Object.fromEntries(map) : {};
    }
    case 'window.close':
      await chrome.tabs.remove(ctx.tabId);
      return undefined;
    case 'window.focus': {
      const tab = await chrome.tabs.get(ctx.tabId);
      if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await chrome.tabs.update(ctx.tabId, { active: true });
      return undefined;
    }
    case 'GM_setClipboard': {
      // Clipboard writes are performed in the content-world host, where the
      // Clipboard API is available; this path is a defensive fallback.
      throw new Error('GM_setClipboard is handled by the host runtime.');
    }
    case 'GM_log':
      await recordLog('info', args, ctx.uuid, ctx.url);
      return undefined;
    default:
      throw new Error(`Unsupported GM API: ${api}`);
  }
}

function notificationEventPayload(notificationId: string): Record<string, unknown> | null {
  const target = notificationTargets.get(notificationId);
  if (!target) return null;
  return {
    uuid: target.uuid,
    id: notificationId,
    ...(notificationDetails.get(notificationId) ?? {}),
  };
}

export function onNotificationClicked(notificationId: string): void {
  const target = notificationTargets.get(notificationId);
  if (!target) return;
  sendToHost(target.tabId, target.frameId, {
    type: 'bg:event',
    event: 'notification-click',
    payload: notificationEventPayload(notificationId) ?? { uuid: target.uuid, id: notificationId },
  });
}

export function onNotificationButtonClicked(notificationId: string, index: number): void {
  const target = notificationTargets.get(notificationId);
  if (!target) return;
  sendToHost(target.tabId, target.frameId, {
    type: 'bg:event',
    event: 'notification-click',
    payload: {
      ...(notificationEventPayload(notificationId) ?? { uuid: target.uuid, id: notificationId }),
      event: 'buttonClick',
      isButtonClick: true,
      buttonIndex: index,
    },
  });
}

export function onNotificationClosed(notificationId: string, byUser = false): void {
  const target = notificationTargets.get(notificationId);
  if (!target) return;
  const details = notificationDetails.get(notificationId) ?? {};
  notificationTargets.delete(notificationId);
  notificationDetails.delete(notificationId);
  sendToHost(target.tabId, target.frameId, {
    type: 'bg:event',
    event: 'notification-close',
    payload: { uuid: target.uuid, id: notificationId, byUser, ...details },
  });
}
