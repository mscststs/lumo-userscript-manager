/** SHA-256 as lowercase hex. */
export async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
