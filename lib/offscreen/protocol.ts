/**
 * Messages exchanged between the service worker and the offscreen document.
 *
 * The offscreen document exists because a MV3 service worker has no DOM and no
 * `XMLHttpRequest`; userscripts are written against XHR semantics
 * (`readyState`, `responseXML`, upload progress, `overrideMimeType`, document
 * responses). Reimplementing those on top of `fetch` is what produced the
 * 412/`DataCloneError` class of bugs, so the request itself runs natively in an
 * extension page and only events/results cross the process boundary.
 */

/** Name of the long-lived port the worker uses to talk to the document. */
export const OFFSCREEN_PORT = 'lumo-offscreen';

export type OffscreenCommand = 'XHRStart' | 'XHRStop' | 'ClipboardSet';

export interface OffscreenXhrRequest {
  /** Correlates events, aborts and the final result. */
  id: string;
  url: string;
  method: string;
  /** Headers `XHR.setRequestHeader` accepts; forbidden ones are applied by DNR. */
  headers: Record<string, string>;
  /** Raw request body; binary payloads arrive base64 encoded. */
  bodyBase64?: string;
  /** Milliseconds; `0` means "no timeout". */
  timeout: number;
  /** `''` | `text` | `json` | `arraybuffer` | `blob` | `document`. */
  responseType: string;
  overrideMimeType?: string;
  user?: string;
  password?: string;
  /** `error` fails the request if a redirect happened; `manual` degrades to follow. */
  redirect: 'follow' | 'error';
  nocache: boolean;
  revalidate: boolean;
  /** Tampermonkey sends cookies unless the script asks for `anonymous`. */
  withCredentials: boolean;
}

export type OffscreenXhrEvent =
  | {
      type: 'state';
      readyState: number;
      status: number;
      statusText: string;
      finalUrl: string;
      responseHeaders: string;
      contentType: string;
    }
  | {
      type: 'progress';
      upload: boolean;
      loaded: number;
      total: number;
      lengthComputable: boolean;
    };

export interface OffscreenXhrResult {
  status: number;
  statusText: string;
  responseHeaders: string;
  finalUrl: string;
  contentType: string;
  responseText?: string;
  /** Present for `arraybuffer` / `blob`; base64 encoded for transport. */
  responseBase64?: string;
  /** Serialized document for `document` responses and parseable XML/HTML. */
  documentText?: string;
  /** Parsed value for `json`; `null` when the body is not valid JSON. */
  json?: unknown;
  error?: string;
  /** Why the request failed; lets the page decide between onerror/ontimeout/onabort. */
  errorKind?: 'timeout' | 'abort' | 'network' | 'redirect' | 'collect';
  /** True when `redirect: "error"` was requested and a redirect happened. */
  redirectRejected?: boolean;
}

export interface OffscreenRequestMessage {
  id: string;
  cmd: OffscreenCommand;
  data: unknown;
}

export interface OffscreenReplyMessage {
  id: string;
  error?: string;
  result?: unknown;
  event?: OffscreenXhrEvent;
}

export interface OffscreenClipboardRequest {
  data: string;
  mime: string;
}
