import { getScript } from '@/lib/db';
import { mergeMetadata } from '@/lib/script/metadata';
import { sendToHost } from './host-ports';
import { recordLog } from './logs';
import { handleXhr, abortXhr } from './xhr';
import { handleCookie } from './cookie';
import {
  closeNotification,
  handleNotification,
  onNotificationButtonClicked,
  onNotificationClicked,
  onNotificationClosed,
  updateNotification,
} from './notification';
import { abortDownload, handleDownload, onDownloadChanged } from './download';
import { clearTabStateForTab, getTabState, listTabStates, saveTabState } from './tabs';
import { writeClipboard } from './offscreen';

export {
  onDownloadChanged,
  onNotificationButtonClicked,
  onNotificationClicked,
  onNotificationClosed,
};

export interface GmRequestContext {
  tabId: number;
  frameId: number;
  url: string;
  uuid: string;
}

const openTabTargets = new Map<number, GmRequestContext>();

export function onTabRemoved(tabId: number): void {
  void clearTabStateForTab(tabId).catch(() => undefined);
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
    case 'GM_xmlhttpRequestAbort':
      abortXhr(String(args[0] ?? ''));
      return undefined;
    case 'GM_cookie':
      return handleCookie(script, args, ctx.url);
    case 'GM_download':
      return handleDownload(script, args, ctx.url, ctx);
    case 'GM_downloadAbort':
      await abortDownload(String(args[0] ?? ''));
      return undefined;
    case 'GM_notification':
      return handleNotification(ctx, args);
    case 'GM_closeNotification':
      await closeNotification(String(args[0] ?? ''));
      return undefined;
    case 'GM_updateNotification': {
      const [id, details] = args as [string, Record<string, unknown>];
      await updateNotification(String(id), details ?? {});
      return undefined;
    }
    case 'GM_openInTab': {
      const [url, options = {}] = args as [string, Record<string, any>];
      const target = new URL(url, ctx.url || undefined).toString();
      // `insert` opens right after the current tab; `setParent` keeps the
      // opener relationship so `window.opener` behaves like Tampermonkey.
      const current =
        (options.insert || options.setParent) && ctx.tabId >= 0
          ? await chrome.tabs.get(ctx.tabId).catch(() => null)
          : null;
      const tab = await chrome.tabs.create({
        url: target,
        active: Boolean(options.active),
        ...(options.insert && current ? { index: current.index + 1 } : {}),
        ...(options.setParent && ctx.tabId >= 0 ? { openerTabId: ctx.tabId } : {}),
      });
      if (tab.id !== undefined) openTabTargets.set(tab.id, ctx);
      return tab;
    }
    case 'GM_closeInTab': {
      const tabId = Number(args[0]);
      if (Number.isFinite(tabId)) await chrome.tabs.remove(tabId);
      return undefined;
    }
    case 'GM_getTab':
      return getTabState(ctx.uuid, ctx.tabId);
    case 'GM_saveTab':
      await saveTabState(ctx.uuid, ctx.tabId, args[0]);
      return undefined;
    case 'GM_getTabs':
      return listTabStates(ctx.uuid);
    case 'window.close':
      if (ctx.tabId >= 0) await chrome.tabs.remove(ctx.tabId).catch(() => undefined);
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
      const [data, mime] = args as [string?, string?];
      await writeClipboard(String(data ?? ''), String(mime ?? 'text/plain'));
      return undefined;
    }
    case 'GM_log':
      await recordLog('info', args, ctx.uuid, ctx.url);
      return undefined;
    default:
      throw new Error(`Unsupported GM API: ${api}`);
  }
}

