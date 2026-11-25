import type { UserScript } from '@/types';
import { requireConnect } from './connect';
import { sendToHost } from './host-ports';
import {
  installXhrRule,
  planXhrHeaders,
  withRequestMarker,
  type XhrHeaderPlan,
} from './xhr/header-rules';

/**
 * `GM_download`.
 *
 * The browser download manager performs the transfer, so the request is not an
 * XHR and cannot use the header payload of `GM_xmlhttpRequest`. Headers and
 * `anonymous` are applied with the same one-shot DNR rule strategy, scoped to
 * `other` requests (that is how the download manager shows up in the network
 * stack) and to the unique URL marker.
 */

export interface DownloadContext {
  tabId: number;
  frameId: number;
  url: string;
  uuid: string;
}

interface DownloadTarget {
  requestId: string;
  ctx: DownloadContext;
  rule: { release: () => Promise<void> } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const targets = new Map<number, DownloadTarget>();
const requests = new Map<string, { downloadId: number; ctx: DownloadContext }>();

export interface DownloadStartResult {
  id: number;
  requestId: string;
}

export async function handleDownload(
  script: UserScript,
  args: unknown[],
  pageUrl: string | undefined,
  ctx: DownloadContext,
): Promise<DownloadStartResult> {
  const details = (args[0] ?? {}) as Record<string, any>;
  const requestId = String(details.requestId ?? crypto.randomUUID());
  const rawUrl = String(details.url ?? '');
  const url = new URL(rawUrl, pageUrl || undefined).toString();
  requireConnect(script, url, 'GM_download', pageUrl);

  const plan: XhrHeaderPlan = planXhrHeaders(details.headers, {
    anonymous: Boolean(details.anonymous),
  });
  const requestUrl = plan.needsRule ? withRequestMarker(url, requestId) : url;
  const rule = await installXhrRule(url, requestUrl, plan, {
    resourceTypes: ['other' as chrome.declarativeNetRequest.ResourceType],
  });

  try {
    const id = await chrome.downloads.download({
      url: requestUrl,
      filename: details.name ?? details.filename,
      saveAs: Boolean(details.saveAs),
      conflictAction: details.conflictAction,
    });
    const timeout = Number(details.timeout) || 0;
    const timer =
      timeout > 0
        ? setTimeout(() => {
            void chrome.downloads.cancel(id).catch(() => undefined);
            targets.delete(id);
            requests.delete(requestId);
            sendToHost(ctx.tabId, ctx.frameId, {
              type: 'bg:event',
              event: 'download-result',
              payload: { uuid: ctx.uuid, requestId, error: 'Timeout', errorKind: 'timeout' },
            });
          }, timeout)
        : null;
    targets.set(id, { requestId, ctx, rule, timer });
    requests.set(requestId, { downloadId: id, ctx });
    return { id, requestId };
  } catch (error) {
    await rule?.release();
    throw error;
  }
}

export async function abortDownload(requestId: string): Promise<void> {
  const target = requests.get(requestId);
  if (!target) return;
  requests.delete(requestId);
  const entry = targets.get(target.downloadId);
  if (entry) {
    if (entry.timer) clearTimeout(entry.timer);
    targets.delete(target.downloadId);
    await entry.rule?.release();
  }
  await chrome.downloads.cancel(target.downloadId).catch(() => undefined);
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

export function onDownloadChanged(
  downloadId: number,
  delta: chrome.downloads.DownloadDelta,
): void {
  const target = targets.get(downloadId);
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
    if (target.timer) clearTimeout(target.timer);
    targets.delete(downloadId);
    requests.delete(target.requestId);
    void target.rule?.release();
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
          error: String(error),
          errorKind: 'network',
          result: downloadPayload(downloadId, item as unknown as Record<string, unknown>),
        },
      });
    }
  });
}
