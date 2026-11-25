import type {
  OffscreenXhrEvent,
  OffscreenXhrRequest,
  OffscreenXhrResult,
} from './protocol';

/** Response types the native XHR understands (everything else degrades to text). */
// `json` is parsed here instead of using the native `responseType = 'json'`:
// with that native type, reading `responseText` throws, and invalid JSON would
// turn into a request error instead of `response === null`.
const NATIVE_TYPES = new Set(['', 'text', 'arraybuffer', 'blob', 'document']);

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Cannot read the response Blob.'));
    reader.readAsDataURL(blob);
  });
}

function serializeDocument(response: Document | null, contentType: string): string | undefined {
  if (!response) return undefined;
  try {
    // `XMLSerializer` cannot serialize an HTML document; `outerHTML` is the
    // faithful representation and survives the round trip through DOMParser.
    if (contentType.includes('html')) return response.documentElement?.outerHTML ?? undefined;
    return new XMLSerializer().serializeToString(response);
  } catch {
    return undefined;
  }
}

/** Normalizes `getAllResponseHeaders()` to the `name: value\r\n` shape GM uses. */
function encodeResponseHeaders(xhr: XMLHttpRequest): string {
  const raw = xhr.getAllResponseHeaders() ?? '';
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(':');
      return index > 0
        ? `${line.slice(0, index).trim()}: ${line.slice(index + 1).trim()}`
        : line;
    })
    .join('\r\n');
}

function contentTypeOf(xhr: XMLHttpRequest): string {
  return (xhr.getResponseHeader('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

async function collectResult(
  xhr: XMLHttpRequest,
  request: OffscreenXhrRequest,
): Promise<OffscreenXhrResult> {
  const contentType = contentTypeOf(xhr);
  const base: OffscreenXhrResult = {
    status: xhr.status,
    statusText: xhr.statusText,
    responseHeaders: encodeResponseHeaders(xhr),
    finalUrl: xhr.responseURL || request.url,
    contentType,
  };

  const type = request.responseType;
  if (type === 'arraybuffer') {
    const buffer = xhr.response as ArrayBuffer | null;
    return { ...base, responseBase64: buffer ? bytesToBase64(buffer) : '' };
  }
  if (type === 'blob') {
    const blob = xhr.response as Blob | null;
    return { ...base, responseBase64: blob ? await blobToBase64(blob) : '' };
  }
  if (type === 'document') {
    const document = xhr.response as Document | null;
    const text = serializeDocument(document, contentType);
    if (text === undefined) return { ...base, status: 0, error: 'The response could not be parsed as a Document.' };
    return { ...base, documentText: text };
  }

  const responseText = String(xhr.responseText ?? '');
  if (type === 'json') {
    if (!responseText) return { ...base, json: null, responseText };
    try {
      return { ...base, json: JSON.parse(responseText), responseText };
    } catch {
      // Native XHR yields `response === null` for invalid JSON instead of failing.
      return { ...base, json: null, responseText };
    }
  }
  // `redirect` is decided by the worker: the request URL carries the DNR
  // marker fragment, so `responseURL` (which never includes a fragment) can
  // never be compared here.
  //
  // `responseXML`/`response` parsing happens on the page side, where a
  // DOMParser belongs; shipping the text keeps the transport small.
  return { ...base, responseText };
}

/**
 * Run one GM request with the native XHR and stream its events back.
 *
 * Resolves (never rejects) with the terminal result; `error` is set for
 * network failures, timeouts and aborts so the caller can map them to
 * `onerror` / `ontimeout` / `onabort` exactly like a real XHR.
 */
export interface XhrHandle {
  promise: Promise<OffscreenXhrResult>;
  abort: () => void;
}

export function runXhr(
  request: OffscreenXhrRequest,
  emit: (event: OffscreenXhrEvent) => void,
): XhrHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<OffscreenXhrResult>((resolve) => {
    let settled = false;
    const finish = async (error?: string, errorKind?: OffscreenXhrResult['errorKind']) => {
      if (settled) return;
      settled = true;
      try {
        const result = await collectResult(xhr, request);
        resolve(error ? { ...result, error, ...(errorKind ? { errorKind } : {}) } : result);
      } catch (collectError) {
        resolve({
          status: xhr.status,
          statusText: xhr.statusText,
          responseHeaders: encodeResponseHeaders(xhr),
          finalUrl: xhr.responseURL || request.url,
          contentType: contentTypeOf(xhr),
          error: String(collectError),
          errorKind: 'collect',
        });
      }
    };

    try {
      xhr.open(request.method, request.url, true, request.user || null, request.password || null);
      const nativeType =
        request.responseType === 'json'
          ? ''
          : NATIVE_TYPES.has(request.responseType)
            ? request.responseType
            : '';
      try {
        xhr.responseType = nativeType as XMLHttpRequestResponseType;
      } catch {
        // Older engines reject unknown values; text is the safe default.
        xhr.responseType = 'text';
      }
      xhr.withCredentials = request.withCredentials;
      if (request.overrideMimeType) xhr.overrideMimeType(request.overrideMimeType);
      if (request.timeout > 0) xhr.timeout = request.timeout;
      if (request.nocache) {
        xhr.setRequestHeader('Cache-Control', 'no-cache');
        xhr.setRequestHeader('Pragma', 'no-cache');
      } else if (request.revalidate) {
        xhr.setRequestHeader('Cache-Control', 'max-age=0');
      }
      for (const [name, value] of Object.entries(request.headers)) {
        try {
          xhr.setRequestHeader(name, value);
        } catch {
          // Forbidden headers are applied by the DNR rule instead; ignore here.
        }
      }

      xhr.onreadystatechange = () => {
        if (xhr.readyState < 2) return;
        emit({
          type: 'state',
          readyState: xhr.readyState,
          status: xhr.status,
          statusText: xhr.statusText,
          finalUrl: xhr.responseURL || '',
          responseHeaders: xhr.readyState >= 2 ? encodeResponseHeaders(xhr) : '',
          contentType: contentTypeOf(xhr),
        });
        if (xhr.readyState === 4 && xhr.status !== 0) void finish();
      };
      xhr.onprogress = (event) => {
        emit({
          type: 'progress',
          upload: false,
          loaded: event.loaded,
          total: event.total,
          lengthComputable: event.lengthComputable,
        });
      };
      xhr.upload.onprogress = (event) => {
        emit({
          type: 'progress',
          upload: true,
          loaded: event.loaded,
          total: event.total,
          lengthComputable: event.lengthComputable,
        });
      };
      xhr.onload = () => void finish();
      xhr.onerror = () => void finish('Network request failed.', 'network');
      xhr.ontimeout = () => void finish('Timeout', 'timeout');
      xhr.onabort = () => void finish('Aborted', 'abort');

      const body = request.bodyBase64 ? base64ToBytes(request.bodyBase64) : null;
      xhr.send(body ? (body.buffer as ArrayBuffer) : null);
    } catch (error) {
      xhr.onreadystatechange = null;
      resolve({
        status: 0,
        statusText: '',
        responseHeaders: '',
        finalUrl: request.url,
        contentType: '',
        error: error instanceof Error ? error.message : String(error),
        errorKind: 'network',
      });
    }
  });
  return { promise, abort: () => { try { xhr.abort(); } catch { /* already finished */ } } };
}
