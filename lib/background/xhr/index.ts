import type { UserScript } from '@/types';
import type {
  OffscreenXhrEvent,
  OffscreenXhrRequest,
  OffscreenXhrResult,
} from '@/lib/offscreen/protocol';
import { canConnect, requireConnect } from '../connect';
import { sendToHost } from '../host-ports';
import { callOffscreen, stopOffscreenXhr } from '../offscreen';
import {
  installXhrRule,
  planXhrHeaders,
  stripRequestMarker,
  withRequestMarker,
} from './header-rules';

/**
 * `GM_xmlhttpRequest` orchestration.
 *
 * The worker validates `@connect`, plans the header rewrite, installs the
 * one-shot DNR rule and forwards events; the offscreen document performs the
 * native XHR. Keeping the three concerns apart is what makes the semantics
 * verifiable: the request itself is a real XHR, and the worker never has to
 * emulate `readyState` or `responseXML`.
 */

export interface XhrContext {
  tabId: number;
  frameId: number;
  url: string;
  uuid: string;
}

export interface XhrResponsePayload {
  status: number;
  statusText: string;
  responseHeaders: string;
  finalUrl: string;
  contentType: string;
  readyState: number;
  responseText?: string;
  responseBase64?: string;
  documentText?: string;
  json?: unknown;
  error?: string;
  errorKind?: OffscreenXhrResult['errorKind'];
}

const inFlight = new Set<string>();

export function abortXhr(requestId: string): void {
  if (!inFlight.delete(requestId)) return;
  stopOffscreenXhr(requestId);
}

function forwardEvent(event: OffscreenXhrEvent, requestId: string, ctx: XhrContext): void {
  if (event.type === 'state') {
    // `readyState === 4` is delivered by the RPC result so the page sees the
    // same object the request resolves with, in order.
    if (event.readyState >= 4) return;
    sendToHost(ctx.tabId, ctx.frameId, {
      type: 'bg:event',
      event: 'xhr-state',
      payload: {
        uuid: ctx.uuid,
        requestId,
        readyState: event.readyState,
        status: event.status,
        statusText: event.statusText,
        finalUrl: stripRequestMarker(event.finalUrl),
        responseHeaders: event.responseHeaders,
        contentType: event.contentType,
      },
    });
    return;
  }
  sendToHost(ctx.tabId, ctx.frameId, {
    type: 'bg:event',
    event: 'xhr-progress',
    payload: {
      uuid: ctx.uuid,
      requestId,
      upload: event.upload,
      loaded: event.loaded,
      total: event.total,
      lengthComputable: event.lengthComputable,
    },
  });
}

function redirectRequested(options: Record<string, any>, originalUrl: string, result: OffscreenXhrResult): boolean {
  if (options.redirect !== 'error') return false;
  const landed = stripRequestMarker(result.finalUrl || '');
  return Boolean(landed) && landed !== stripRequestMarker(originalUrl);
}

export async function handleXhr(
  script: UserScript,
  args: unknown[],
  pageUrl: string | undefined,
  ctx: XhrContext,
): Promise<XhrResponsePayload> {
  const options = (args[0] ?? {}) as Record<string, any>;
  const originalUrl = new URL(String(options.url ?? ''), pageUrl || undefined).toString();
  requireConnect(script, originalUrl, 'GM_xmlhttpRequest', pageUrl);

  const requestId = String(options.requestId ?? crypto.randomUUID());
  const anonymous = Boolean(options.anonymous);
  const plan = planXhrHeaders(options.headers, { anonymous });
  // The page side encoded the body (FormData/binary cannot cross the bridge).
  const body = {
    base64: options.dataBase64 ? String(options.dataBase64) : undefined,
    contentType: options.dataContentType ? String(options.dataContentType) : undefined,
  };
  const headers = { ...plan.headers };
  if (
    body.contentType &&
    !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
  ) {
    headers['Content-Type'] = body.contentType;
  }

  const requestUrl = withRequestMarker(originalUrl, requestId);
  const timeout = Number(options.timeout) || 0;
  const rule = await installXhrRule(originalUrl, requestUrl, plan);
  inFlight.add(requestId);
  // Redirects are followed by the browser; authorize every landed URL, not
  // just the one the script asked for. Otherwise `@connect` is a formality.
  let blockedRedirect = false;
  const forward = (event: OffscreenXhrEvent) => {
    if (event.type === 'state' && event.readyState >= 2 && event.finalUrl && !blockedRedirect) {
      if (!canConnect(script, event.finalUrl, pageUrl)) {
        blockedRedirect = true;
        abortXhr(requestId);
        return;
      }
    }
    forwardEvent(event, requestId, ctx);
  };

  const request: OffscreenXhrRequest = {
    id: requestId,
    url: requestUrl,
    method: String(options.method ?? 'GET'),
    headers,
    bodyBase64: body.base64,
    timeout,
    responseType: String(options.responseType ?? ''),
    overrideMimeType: options.overrideMimeType ? String(options.overrideMimeType) : undefined,
    user: options.user ? String(options.user) : undefined,
    password: options.password ? String(options.password) : undefined,
    redirect: options.redirect === 'error' ? 'error' : 'follow',
    nocache: Boolean(options.nocache),
    revalidate: Boolean(options.revalidate),
    withCredentials: !anonymous,
  };

  try {
    const result = await callOffscreen<OffscreenXhrResult>('XHRStart', request, {
      timeoutMs: timeout > 0 ? timeout + 10_000 : 120_000,
      onEvent: forward,
    });
    const finalUrl = stripRequestMarker(result.finalUrl || requestUrl);
    if (blockedRedirect) {
      return {
        status: 0,
        statusText: '',
        responseHeaders: '',
        finalUrl,
        contentType: result.contentType,
        readyState: 4,
        error: 'The request was redirected outside @connect and was aborted.',
        errorKind: 'redirect',
      };
    }
    if (redirectRequested(options, originalUrl, result)) {
      return {
        status: 0,
        statusText: '',
        responseHeaders: result.responseHeaders,
        finalUrl,
        contentType: result.contentType,
        readyState: 4,
        error: 'Redirected request rejected (redirect: "error").',
        errorKind: 'redirect',
      };
    }
    return {
      status: result.status,
      statusText: result.statusText,
      responseHeaders: result.responseHeaders,
      finalUrl,
      contentType: result.contentType,
      readyState: 4,
      responseText: result.responseText,
      responseBase64: result.responseBase64,
      documentText: result.documentText,
      json: result.json,
      error: result.error,
      errorKind: result.errorKind,
    };
  } finally {
    inFlight.delete(requestId);
    await rule?.release();
  }
}
