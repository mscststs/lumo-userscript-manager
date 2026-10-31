import type { ScriptMetadata, UserScript } from '@/types';
import {
  addLog,
  replaceResources,
  deleteDraft,
  deleteValuesForStorage,
  findByNameNamespace,
  getDraft,
  getResources,
  getScript,
  getScriptCode,
  getScriptWithCode,
  getValues,
  listScripts,
  listVersions,
  moveScriptToTrash,
  purgeScript,
  putDraft,
  recordRun,
  restoreScript,
  saveScript,
  setScriptEnabled,
  updateScriptPartial,
} from '@/lib/db';
import {
  mergeMetadata,
  parseMetadata,
  getMeta,
  getMetaList,
  hasMeta,
  splitTags,
  resolveMetadataUrls,
} from '@/lib/script/metadata';
import { getPageAccess, isFileUrl, type PageAccess } from '@/lib/page-access';
import { byteLength, sha256Hex } from '@/lib/script/hash';
import { getStorageName } from '@/lib/script/storage-name';
import { collectMetadataWarnings } from '@/lib/script/analyze';
import { storage } from '@/store/storage';
import { evaluateScripts } from './matching';
import { refreshScriptResources } from './resources';
import { getValuesForScript } from './values';
import { cacheScriptIcon, resolveScriptIcons } from './icons';
import { requestRegistration } from './registry';
import { getRuntimeStatus } from './registry';
import { forgetInjectedScript } from './injected-state';

export function broadcast(event: string, payload: Record<string, unknown> = {}): void {
  void chrome.runtime.sendMessage({ type: 'lumo:event', event, payload }).catch(() => undefined);
}

function firstMeta(metadata: ScriptMetadata, key: string): string | undefined {
  return getMeta(metadata, key);
}

function firstMetaOf(metadata: ScriptMetadata, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = getMeta(metadata, key);
    if (value) return value;
  }
  return undefined;
}

function normalizeMetadata(metadata: ScriptMetadata): ScriptMetadata {
  return { ...metadata, namespace: metadata.namespace ?? [''] };
}

function tagsFor(metadata: ScriptMetadata): string[] {
  return splitTags(metadata);
}

function updateUrls(sourceUrl: string, metadata: ScriptMetadata) {
  const download = firstMeta(metadata, 'downloadurl') || sourceUrl || undefined;
  const update = firstMeta(metadata, 'updateurl') || download;
  return { downloadUrl: download, updateUrl: update };
}

async function makeScriptRecord(
  rawMetadata: ScriptMetadata,
  code: string,
  existing: UserScript | undefined,
  sourceUrl: string,
  uuidOverride?: string,
): Promise<UserScript> {
  const metadata = resolveMetadataUrls(
    normalizeMetadata(rawMetadata),
    sourceUrl || existing?.origin || existing?.downloadUrl,
  );
  const settings = await storage.getUISettings();
  const now = Date.now();
  const { downloadUrl, updateUrl } = updateUrls(sourceUrl, metadata);
  const runAtValue = firstMeta(metadata, 'run-at') ?? settings.defaultRunAt;
  const runAt =
    runAtValue === 'document-start' ||
    runAtValue === 'document-end' ||
    runAtValue === 'document-body' ||
    runAtValue === 'context-menu' ||
    runAtValue === 'early-start'
      ? runAtValue
      : 'document-idle';
  const injectValue = firstMeta(metadata, 'inject-into') ?? existing?.injectInto ?? settings.defaultInjectInto;
  const injectInto =
    injectValue === 'page' || injectValue === 'content' || injectValue === 'auto'
      ? injectValue
      : 'auto';

  return {
    uuid: existing?.uuid ?? uuidOverride ?? crypto.randomUUID(),
    name: firstMeta(metadata, 'name') ?? 'Untitled script',
    namespace: firstMeta(metadata, 'namespace') ?? '',
    version: firstMeta(metadata, 'version') ?? '',
    description: firstMeta(metadata, 'description'),
    author: firstMeta(metadata, 'author'),
    homepage: firstMetaOf(metadata, ['homepage', 'homepageurl', 'website', 'source']),
    supportUrl: firstMeta(metadata, 'supporturl'),
    icon: firstMetaOf(metadata, ['icon', 'iconurl', 'icon64', 'icon64url', 'defaulticon']),
    antifeature: metadata.antifeature ?? [],

    enabled: existing?.enabled ?? true,
    // Preserve the review marker across edits: an agent polishing its own
    // pending script must not clear the user's review gate.
    pendingReview: existing?.pendingReview,
    removedAt: undefined,
    sort: existing?.sort ?? -Date.now(),

    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt,
    runCount: existing?.runCount ?? 0,

    origin: sourceUrl || existing?.origin || '',
    downloadUrl,
    updateUrl,
    checkUpdate: Boolean(updateUrl),
    updateIntervalHours: existing?.updateIntervalHours,
    updateState: 'idle',
    lastError: existing?.lastError,

    metadata,
    selfMetadata: existing?.selfMetadata,

    tags: tagsFor(metadata),
    grant: metadata.grant ?? ['none'],
    connect: (metadata.connect ?? []).filter(Boolean),
    require: (metadata.require ?? []).filter(Boolean),
    resource: (metadata.resource ?? [])
      .map((value) => value.trim().split(/\s+/, 1)[0])
      .filter((value): value is string => Boolean(value)),

    runAt,
    injectInto,
    noFrames: hasMeta(metadata, 'noframes'),
    unwrap: hasMeta(metadata, 'unwrap'),
    topLevelAwait: hasMeta(metadata, 'top-level-await'),

    codeHash: await sha256Hex(code),
    codeSize: byteLength(code),
  };
}

export async function getAllScripts(includeRemoved = false): Promise<UserScript[]> {
  return listScripts(includeRemoved);
}

export async function getScriptDetail(uuid: string) {
  const script = await getScriptWithCode(uuid);
  if (!script) return null;
  const [resources, valueData, versions] = await Promise.all([
    getResources(uuid),
    getValuesForScript(uuid),
    listVersions(uuid),
  ]);
  return { script, resources, values: valueData.values, versions };
}

export interface SaveScriptOptions {
  /** Force the initial enabled state instead of inheriting the previous one. */
  enabled?: boolean;
  /** Mark the script as awaiting user review. */
  pendingReview?: boolean;
}

export async function saveScriptFromCode(
  uuid: string | null,
  code: string,
  sourceUrl = '',
  options: SaveScriptOptions = {},
): Promise<UserScript> {
  const parsed = parseMetadata(code);
  if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
  const existing = uuid ? await getScript(uuid) : undefined;
  const metadata = resolveMetadataUrls(
    normalizeMetadata(parsed.metadata),
    sourceUrl || existing?.origin || existing?.downloadUrl || '',
  );
  const byName = await findByNameNamespace(metadata.name?.[0] ?? '', metadata.namespace?.[0] ?? '');
  if (byName && byName.uuid !== existing?.uuid) {
    throw new Error(`A script named "${byName.name}" in namespace "${byName.namespace}" already exists.`);
  }

  const record = await makeScriptRecord(metadata, code, existing, sourceUrl || existing?.origin || '');
  if (options.enabled !== undefined) record.enabled = options.enabled;
  if (options.pendingReview !== undefined) record.pendingReview = options.pendingReview;
  await saveScript(record, code);
  await refreshScriptResources(record.uuid, metadata);
  // Identity icon: warm the cache now so the popup paints a real favicon on
  // first open instead of paying for the request itself.
  void cacheScriptIcon(record.uuid, record.icon);
  await requestRegistration();
  broadcast('scripts-changed');
  return record;
}

export async function updateSelfMetadata(uuid: string, selfMetadata: ScriptMetadata): Promise<UserScript> {
  const script = await getScript(uuid);
  if (!script) throw new Error('Script not found.');
  const effective = resolveMetadataUrls(
    mergeMetadata(script.metadata, selfMetadata),
    script.origin || script.downloadUrl || script.updateUrl,
  );
  const parsed = parseMetadata(
    `// ==UserScript==\n${Object.entries(effective)
      .flatMap(([key, values]) => (values ?? []).map((value) => `// @${key} ${value}`))
      .join('\n')}\n// ==/UserScript==`,
  );
  if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));

  const next: UserScript = {
    ...script,
    selfMetadata,
    name: firstMeta(effective, 'name') ?? script.name,
    namespace: firstMeta(effective, 'namespace') ?? script.namespace,
    version: firstMeta(effective, 'version') ?? script.version,
    description: firstMeta(effective, 'description'),
    author: firstMeta(effective, 'author'),
    homepage: firstMetaOf(effective, ['homepage', 'homepageurl', 'website', 'source']),
    supportUrl: firstMeta(effective, 'supporturl'),
    icon: firstMetaOf(effective, ['icon', 'iconurl', 'icon64', 'icon64url', 'defaulticon']),
    antifeature: effective.antifeature ?? [],
    tags: tagsFor(effective),
    grant: effective.grant ?? ['none'],
    connect: (effective.connect ?? []).filter(Boolean),
    require: (effective.require ?? []).filter(Boolean),
    resource: (effective.resource ?? [])
      .map((value) => value.trim().split(/\s+/, 1)[0])
      .filter((value): value is string => Boolean(value)),
    noFrames: hasMeta(effective, 'noframes'),
    unwrap: hasMeta(effective, 'unwrap'),
    topLevelAwait: hasMeta(effective, 'top-level-await'),
    downloadUrl: firstMeta(effective, 'downloadurl') || script.downloadUrl,
    updateUrl: firstMeta(effective, 'updateurl') || script.updateUrl,
    updatedAt: Date.now(),
  };
  next.checkUpdate = Boolean(next.updateUrl);
  const runAt = firstMeta(effective, 'run-at') ?? (await storage.getUISettings()).defaultRunAt;
  next.runAt =
    runAt === 'document-start' ||
    runAt === 'document-end' ||
    runAt === 'document-body' ||
    runAt === 'context-menu' ||
    runAt === 'early-start'
      ? runAt
      : 'document-idle';
  const injectInto =
    firstMeta(effective, 'inject-into') ?? (await storage.getUISettings()).defaultInjectInto;
  next.injectInto =
    injectInto === 'page' || injectInto === 'content' || injectInto === 'auto'
      ? injectInto
      : 'auto';

  const code = await getScriptCode(uuid);
  if (code === undefined) throw new Error('Script code missing.');
  await saveScript(next, code, { snapshot: false });
  await refreshScriptResources(uuid, effective);
  void cacheScriptIcon(uuid, next.icon);
  await requestRegistration();
  broadcast('scripts-changed');
  return next;
}

export async function toggleScript(uuid: string, enabled: boolean): Promise<void> {
  await setScriptEnabled(uuid, enabled);
  // A disabled script is not running any more, even in the documents it already
  // entered; drop it from the badge instead of waiting for a reload.
  if (!enabled) await forgetInjectedScript(uuid);
  await requestRegistration();
  broadcast('scripts-changed');
}

/**
 * Batch enable/disable with one re-registration pass.
 *
 * Calling `toggleScript` per id would rebuild the whole `chrome.userScripts`
 * registration table once per script; an agent batch of 20 would be 20 passes.
 */
export async function setScriptsEnabled(
  uuids: string[],
  enabled: boolean,
): Promise<{ updated: string[]; missing: string[] }> {
  const updated: string[] = [];
  const missing: string[] = [];
  for (const uuid of uuids) {
    const script = await getScript(uuid);
    if (!script) {
      missing.push(uuid);
      continue;
    }
    await setScriptEnabled(uuid, enabled);
    if (!enabled) await forgetInjectedScript(uuid);
    updated.push(uuid);
  }
  if (updated.length > 0) {
    await requestRegistration();
    broadcast('scripts-changed');
  }
  return { updated, missing };
}

export async function removeScript(uuid: string): Promise<void> {
  await moveScriptToTrash(uuid);
  await forgetInjectedScript(uuid);
  await requestRegistration();
  broadcast('scripts-changed');
}

export async function restoreDeletedScript(uuid: string): Promise<void> {
  await restoreScript(uuid);
  await requestRegistration();
  broadcast('scripts-changed');
}

export async function destroyScript(uuid: string): Promise<void> {
  const script = await getScript(uuid);
  if (script) {
    await deleteValuesForStorage(
      getStorageName({ ...script, metadata: mergeMetadata(script.metadata, script.selfMetadata) }),
    );
  }
  await purgeScript(uuid);
  broadcast('scripts-changed');
}

/** A script started in a tab document. Counted once per document. */
export async function markScriptRun(uuid: string): Promise<void> {
  await recordRun(uuid);
}

/** A running script failed: record the message without counting another run. */
export async function markScriptError(uuid: string, error: string): Promise<void> {
  await recordRun(uuid, error, false);
}

export async function prepareInstall(input: {
  sourceUrl?: string;
  code?: string;
  source?: string;
}): Promise<{ token: string; summary: Record<string, unknown> }> {
  const sourceUrl = input.sourceUrl?.trim() ?? '';
  let code = input.code;
  if (!code) {
    if (!sourceUrl) throw new Error('A script URL or source is required.');
    const response = await fetch(sourceUrl, {
      credentials: 'include',
      redirect: 'follow',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) throw new Error(`Failed to download script: HTTP ${response.status}`);
    const size = Number(response.headers.get('content-length') ?? 0);
    if (size > 5 * 1024 * 1024) throw new Error('Script is larger than 5 MB.');
    code = await response.text();
  }
  if (byteLength(code) > 5 * 1024 * 1024) throw new Error('Script is larger than 5 MB.');

  const parsed = parseMetadata(code);
  if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
  const metadata = resolveMetadataUrls(
    normalizeMetadata(parsed.metadata),
    sourceUrl,
  );
  const existing = await findByNameNamespace(metadata.name?.[0] ?? '', metadata.namespace?.[0] ?? '');
  const token = crypto.randomUUID();
  // Always stage resources under a throwaway id. Overwriting the installed
  // script's resources before the user confirms an update would silently alter
  // the version they are still running.
  const draftUuid = crypto.randomUUID();
  const resourceRecords = await refreshScriptResources(draftUuid, metadata);
  const warnings = collectMetadataWarnings(metadata, parsed.warnings);
  const requireDetails = (metadata.require ?? []).map((url) => {
    const resource = resourceRecords.find((item) => item.url === url);
    return {
      url,
      size: (resource?.content.length ?? 0) + (resource?.base64?.length ?? 0),
      hash: resource?.hash,
    };
  });
  const summary = {
    token,
    sourceUrl,
    isUpdate: Boolean(existing),
    existingUuid: existing?.uuid,
    previousVersion: existing?.version,
    name: metadata.name?.[0] ?? 'Untitled script',
    namespace: metadata.namespace?.[0] ?? '',
    version: metadata.version?.[0] ?? '',
    description: metadata.description?.[0],
    author: metadata.author?.[0],
    icon: firstMetaOf(metadata, ['icon', 'iconurl', 'icon64', 'icon64url', 'defaulticon']),
    homepage: firstMetaOf(metadata, ['homepage', 'homepageurl', 'website', 'source']),
    supportURL: firstMeta(metadata, 'supporturl'),
    antifeature: metadata.antifeature ?? [],
    grant: metadata.grant ?? ['none'],
    connect: metadata.connect ?? [],
    requires: metadata.require ?? [],
    requireCss: metadata['require-css'] ?? [],
    requireDetails,
    resources: (metadata.resource ?? []).map((value) => value.trim().split(/\s+/, 1)[0]!),
    matches: metadata.match ?? [],
    includes: metadata.include ?? [],
    code,
    codeSize: byteLength(code),
    warnings,
    errors: parsed.errors,
  };

  await putDraft({
    ...summary,
    expiresAt: Date.now() + 10 * 60 * 1000,
    draftUuid,
    metadata,
    resourceRecords,
  });
  return { token, summary };
}

export async function commitInstall(
  token: string,
  options: { enabled?: boolean; pendingReview?: boolean } = {},
): Promise<{ uuid: string; updated: boolean }> {
  const draft = await getDraft(token);
  if (!draft) throw new Error('Install draft expired or not found.');
  const metadata = draft.metadata;
  const existing = draft.existingUuid ? await getScript(draft.existingUuid) : undefined;
  const byName = await findByNameNamespace(draft.name, draft.namespace);
  const target = existing ?? byName;
  const record = await makeScriptRecord(
    metadata,
    draft.code,
    target ? { ...target, enabled: options.enabled ?? target.enabled } : undefined,
    draft.sourceUrl,
    draft.draftUuid,
  );
  if (options.enabled !== undefined) record.enabled = options.enabled;
  if (options.pendingReview !== undefined) record.pendingReview = options.pendingReview;
  await saveScript(record, draft.code);
  void cacheScriptIcon(record.uuid, record.icon);
  if (draft.resourceRecords?.length) {
    await replaceResources(
      record.uuid,
      draft.resourceRecords.map((resource) => ({ ...resource, uuid: record.uuid })),
    );
  } else {
    await refreshScriptResources(record.uuid, metadata);
  }
  if (draft.draftUuid !== record.uuid) await replaceResources(draft.draftUuid, []);
  await deleteDraft(token);
  await requestRegistration();
  broadcast('scripts-changed');
  await addLog({
    level: 'info',
    message: `Installed ${record.name} ${record.version}`.trim(),
    time: Date.now(),
    uuid: record.uuid,
    name: record.name,
  });
  return { uuid: record.uuid, updated: Boolean(target) };
}

export interface PopupScriptInfo {
  uuid: string;
  name: string;
  namespace: string;
  version: string;
  enabled: boolean;
  matchesCurrent: boolean;
  excluded: boolean;
  lastError?: string;
  grant: string[];
  /** Cached data URL when warm, otherwise the remote `@icon`, if any. */
  icon?: string;
}

/**
 * Page access for the popup. The scheme/protected-site decision is pure; file
 * URLs additionally depend on Chrome's "Allow access to file URLs" toggle,
 * without which registrations silently never run.
 */
async function resolvePageAccess(url: string | undefined): Promise<PageAccess> {
  const access = getPageAccess(url);
  if (!access.injectable || !isFileUrl(url)) return access;

  try {
    const extensionApi = chrome.extension;
    if (!extensionApi || typeof extensionApi.isAllowedFileSchemeAccess !== 'function') {
      return access;
    }
    const allowed = await extensionApi.isAllowedFileSchemeAccess();
    if (allowed) return access;
    return { injectable: false, reason: 'file-access', label: 'file://' };
  } catch {
    // Older builds may not expose the check; the browser still refuses the
    // injection, but guessing here would hide scripts on valid pages.
    return access;
  }
}

export async function getPopupData(tabId: number, url: string | undefined) {
  const settings = await storage.getUISettings();
  const access = await resolvePageAccess(url);
  const scripts = await listScripts(true);
  const runtime = getRuntimeStatus();
  // One shared evaluator with the toolbar badge, so a row that reads "enabled"
  // here is exactly one of the scripts the badge counted.
  const evaluated = evaluateScripts(scripts, access.injectable ? url : undefined);
  const matching = evaluated.map(({ script, metadata, active, matchesCurrent }) => ({
    uuid: script.uuid,
    name: script.name,
    namespace: script.namespace,
    version: script.version,
    enabled: active,
    matchesCurrent,
    excluded: script.removedAt !== undefined,
    lastError: script.lastError,
    grant: metadata.grant ?? ['none'],
  }));
  const current = access.injectable
    ? matching.filter((script) => script.matchesCurrent && !script.excluded)
    : [];
  // Only the rows on screen need icons; resolving the full library would fetch
  // favicons for scripts this page will never show.
  const icons = await resolveScriptIcons(
    scripts.filter((script) => current.some((row) => row.uuid === script.uuid)),
  );
  return {
    tabId,
    url,
    access,
    settings,
    runtime,
    scripts: current.map((script) => ({ ...script, icon: icons.get(script.uuid) })),
    total: matching.filter((script) => !script.excluded).length,
  };
}
