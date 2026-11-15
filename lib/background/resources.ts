import type { ScriptMetadata, StoredResource } from '@/types';
import { getResources, replaceResources } from '@/lib/db';
import { metadataRequires, metadataRequiresCss, metadataResources } from '@/lib/script/metadata';
import { byteLength, sha256Hex } from '@/lib/script/hash';
import { fetchLimited, isPrivateHost } from '@/lib/net';
import { MAX_RESOURCE_BYTES } from '@/lib/limits';

export interface FetchedResource {
  url: string;
  content: string;
  contentType: string;
  base64?: string;
}

function isBinaryType(contentType: string): boolean {
  return !/^text\/|javascript|json|xml|css|html|svg|plain/i.test(contentType);
}

async function fetchOne(
  url: string,
  credentials: RequestCredentials,
  allowPrivate: boolean,
): Promise<FetchedResource> {
  // Resources are fetched before the user confirms the install, so they must
  // not carry the browser's cookies to an arbitrary host. A script that needs
  // authenticated requests should use GM_xmlhttpRequest after installation.
  const response = await fetchLimited(url, {
    maxBytes: MAX_RESOURCE_BYTES,
    timeoutMs: 15_000,
    credentials,
    allowPrivate,
  });
  const contentType = response.contentType || 'application/octet-stream';
  if (isBinaryType(contentType)) {
    const bytes = response.bytes;
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { url, content: '', contentType, base64: btoa(binary) };
  }
  return { url, content: response.text, contentType };
}

export async function refreshScriptResources(
  uuid: string,
  metadata: ScriptMetadata,
  sourceUrl = '',
): Promise<StoredResource[]> {
  let sourceOrigin = '';
  let sourceIsPrivate = false;
  try {
    if (sourceUrl) {
      const source = new URL(sourceUrl);
      sourceOrigin = source.origin;
      sourceIsPrivate = isPrivateHost(source.hostname);
    }
  } catch {
    // A malformed source simply means no same-origin allowance.
  }
  const existing = await getResources(uuid);
  const existingByUrl = new Map(existing.map((resource) => [resource.url, resource]));
  const resources: StoredResource[] = [];

  const requireUrls = metadataRequires(metadata);
  const requireCssUrls = metadataRequiresCss(metadata);
  const resourceDecls = metadataResources(metadata);

  const tasks: { url: string; name: string; kind: StoredResource['kind'] }[] = [
    ...requireUrls.map((url) => ({ url, name: url, kind: 'require' as const })),
    ...requireCssUrls.map((url) => ({ url, name: url, kind: 'require-css' as const })),
    ...resourceDecls.map((item) => ({ url: item.url, name: item.name, kind: 'resource' as const })),
  ];

  for (const task of tasks) {
    const cached = existingByUrl.get(task.url);
    if (cached) {
      resources.push({ ...cached, name: task.name, kind: task.kind });
      continue;
    }
    try {
      let credentials: RequestCredentials = 'omit';
      let allowPrivate = false;
      try {
        if (sourceOrigin && new URL(task.url).origin === sourceOrigin) {
          credentials = 'include';
          // A script the user installed from a localhost/dev server is allowed
          // to load its own same-origin resources from that server.
          allowPrivate = sourceIsPrivate;
        }
      } catch {
        // Keep the safe default for an unparseable resource URL.
      }
      const fetched = await fetchOne(task.url, credentials, allowPrivate);
      resources.push({
        uuid,
        url: task.url,
        name: task.name,
        kind: task.kind,
        content: fetched.content,
        contentType: fetched.contentType,
        base64: fetched.base64,
        hash: await sha256Hex(fetched.base64 ?? fetched.content),
        fetchedAt: Date.now(),
      });
    } catch (error) {
      console.warn(`[Lumo Userscripts] Failed to fetch resource ${task.url}:`, error);
    }
  }

  await replaceResources(uuid, resources);
  return resources;
}

export async function getRequireSources(uuid: string, metadata: ScriptMetadata): Promise<string[]> {
  const resources = await getResources(uuid);
  const byUrl = new Map(resources.map((resource) => [resource.url, resource]));
  return metadataRequires(metadata)
    .map((url) => byUrl.get(url)?.content ?? '')
    .filter((content) => content.trim());
}

export async function getRequireCssSources(
  uuid: string,
  metadata: ScriptMetadata,
): Promise<string[]> {
  const resources = await getResources(uuid);
  const byUrl = new Map(resources.map((resource) => [resource.url, resource]));
  return metadataRequiresCss(metadata)
    .map((url) => byUrl.get(url)?.content ?? '')
    .filter((content) => content.trim());
}

export function resourcesForRuntime(
  resources: StoredResource[],
  metadata: ScriptMetadata,
): Record<string, { name: string; url: string; content: string; contentType: string; base64?: string }> {
  const byName = new Map(resources.map((resource) => [resource.name, resource]));
  const result: Record<
    string,
    { name: string; url: string; content: string; contentType: string; base64?: string }
  > = {};
  for (const declaration of metadataResources(metadata)) {
    const resource = byName.get(declaration.name);
    if (!resource) continue;
    result[declaration.name] = {
      name: resource.name,
      url: resource.url,
      content: resource.content,
      contentType: resource.contentType,
      base64: resource.base64,
    };
  }
  return result;
}

export function resourceSize(resource: StoredResource): number {
  return byteLength(resource.content) + (resource.base64?.length ?? 0);
}
