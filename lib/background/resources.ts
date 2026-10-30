import type { ScriptMetadata, StoredResource } from '@/types';
import { getResources, replaceResources } from '@/lib/db';
import { metadataRequires, metadataRequiresCss, metadataResources } from '@/lib/script/metadata';
import { byteLength, sha256Hex } from '@/lib/script/hash';

const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;

export interface FetchedResource {
  url: string;
  content: string;
  contentType: string;
  base64?: string;
}

function isBinaryType(contentType: string): boolean {
  return !/^text\/|javascript|json|xml|css|html|svg|plain/i.test(contentType);
}

async function fetchOne(url: string): Promise<FetchedResource> {
  const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESOURCE_BYTES) {
    throw new Error(`Resource is larger than ${MAX_RESOURCE_BYTES} bytes: ${url}`);
  }
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  if (isBinaryType(contentType)) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { url, content: '', contentType, base64: btoa(binary) };
  }
  return { url, content: new TextDecoder().decode(buffer), contentType };
}

export async function refreshScriptResources(
  uuid: string,
  metadata: ScriptMetadata,
): Promise<StoredResource[]> {
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
      const fetched = await fetchOne(task.url);
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
