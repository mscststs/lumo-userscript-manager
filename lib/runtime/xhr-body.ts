/**
 * Request body encoding for `GM_xmlhttpRequest`.
 *
 * Runs on the page side: `FormData` cannot cross the worker `MessagePort`
 * (DataCloneError) and binary values used to be `JSON.stringify`-ed into `"{}"`.
 * Encoding to base64 here keeps one code path for the worker and the offscreen
 * document.
 */

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface EncodedBody {
  base64?: string;
  contentType?: string;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Encode the script-supplied `data` so it survives the worker boundary.
 *
 * `FormData` cannot cross a `MessagePort` (DataCloneError) and binary payloads
 * used to be `JSON.stringify`-ed into `"{}"`; both are normalized to bytes here,
 * which is also what `XMLHttpRequest.send()` ultimately wants.
 */
export async function encodeXhrBody(data: unknown): Promise<EncodedBody> {
  if (data === undefined || data === null) return {};
  if (typeof data === 'string') {
    return { base64: base64(new TextEncoder().encode(data)) };
  }
  if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
    return {
      base64: base64(new TextEncoder().encode(data.toString())),
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    const response = new Response(data);
    const buffer = await response.arrayBuffer();
    return {
      base64: base64(new Uint8Array(buffer)),
      contentType: response.headers.get('content-type') ?? undefined,
    };
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return {
      base64: base64(new Uint8Array(await data.arrayBuffer())),
      contentType: data.type || undefined,
    };
  }
  if (data instanceof ArrayBuffer) {
    return { base64: base64(new Uint8Array(data)) };
  }
  if (ArrayBuffer.isView(data)) {
    return { base64: base64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) };
  }
  if (typeof data === 'object') {
    return {
      base64: base64(new TextEncoder().encode(JSON.stringify(data))),
      contentType: isPlainObject(data) ? 'application/json' : undefined,
    };
  }
  return { base64: base64(new TextEncoder().encode(String(data))) };
}
