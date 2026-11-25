import type { UserScript } from '@/types';
import { sendToHost } from './host-ports';

/**
 * `GM_notification` and the browser notification callbacks.
 *
 * Chrome rejects remote URLs as `iconUrl`, so the script-supplied `image` is
 * downloaded once and embedded as a data URL; the extension icon stays as the
 * fallback. Click handlers stay registered for the lifetime of the
 * notification (a notification can be clicked once, but the button and body
 * clickbacks share the same map entry).
 */

export interface NotificationContext {
  tabId: number;
  frameId: number;
  url: string;
  uuid: string;
}

const notificationTargets = new Map<string, NotificationContext>();
const notificationDetails = new Map<string, Record<string, unknown>>();

async function embedImage(raw: unknown): Promise<string> {
  const fallback = chrome.runtime.getURL('icon/128.png');
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return fallback;
  if (value.startsWith('data:')) return value;
  if (!/^https?:/i.test(value)) return fallback;
  try {
    const response = await fetch(value, { credentials: 'omit' });
    if (!response.ok) return fallback;
    const type = (response.headers.get('content-type') ?? '').split(';')[0] || 'image/png';
    if (!type.startsWith('image/')) return fallback;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 8 * 1024 * 1024) return fallback;
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return fallback;
  }
}

export async function handleNotification(
  ctx: NotificationContext,
  args: unknown[],
): Promise<string> {
  const details = (args[0] ?? {}) as Record<string, any>;
  const id = String(details.id ?? crypto.randomUUID());
  notificationTargets.set(id, ctx);
  notificationDetails.set(id, details);

  const iconUrl = await embedImage(details.image);
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

export function notificationEventPayload(notificationId: string): Record<string, unknown> | null {
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

export async function closeNotification(id: string): Promise<void> {
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
}

export async function updateNotification(
  id: string,
  details: Record<string, unknown>,
): Promise<void> {
  notificationDetails.set(id, { ...(notificationDetails.get(id) ?? {}), ...details });
  await chrome.notifications.update(
    id,
    details as unknown as chrome.notifications.NotificationOptions,
  );
}

export type { UserScript };
