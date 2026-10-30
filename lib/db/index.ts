import type {
  InstallDraftSummary,
  LogEntry,
  ScriptIconCache,
  ScriptMetadata,
  ScriptVersion,
  StoredResource,
  UserScript,
} from '@/types';

const DB_NAME = 'lumo-us';
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('scripts')) {
        const store = db.createObjectStore('scripts', { keyPath: 'uuid' });
        store.createIndex('name', 'name');
        store.createIndex('namespace', 'namespace');
        store.createIndex('updatedAt', 'updatedAt');
        store.createIndex('removedAt', 'removedAt');
        store.createIndex('enabled', 'enabled');
      }

      if (!db.objectStoreNames.contains('code')) {
        db.createObjectStore('code', { keyPath: 'uuid' });
      }

      if (!db.objectStoreNames.contains('versions')) {
        const store = db.createObjectStore('versions', { keyPath: 'id' });
        store.createIndex('uuid', 'uuid');
      }

      if (!db.objectStoreNames.contains('values')) {
        const store = db.createObjectStore('values', { keyPath: ['storageName', 'key'] });
        store.createIndex('storageName', 'storageName');
      }

      if (!db.objectStoreNames.contains('resources')) {
        const store = db.createObjectStore('resources', { keyPath: ['uuid', 'url'] });
        store.createIndex('uuid', 'uuid');
      }

      if (!db.objectStoreNames.contains('logs')) {
        const store = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        store.createIndex('uuid', 'uuid');
        store.createIndex('time', 'time');
      }

      if (!db.objectStoreNames.contains('drafts')) {
        const store = db.createObjectStore('drafts', { keyPath: 'token' });
        store.createIndex('expiresAt', 'expiresAt');
      }

      // v2: identity icons live beside the script records they belong to.
      if (!db.objectStoreNames.contains('icons')) {
        db.createObjectStore('icons', { keyPath: 'uuid' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });

  return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(storeName, mode);
  const result = await fn(tx.objectStore(storeName));
  await txDone(tx);
  return result;
}

export async function getAll<T>(storeName: string): Promise<T[]> {
  return withStore(storeName, 'readonly', (store) => requestResult(store.getAll()));
}

export async function getRecord<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return withStore(storeName, 'readonly', (store) => requestResult(store.get(key)));
}

export async function putRecord<T>(storeName: string, value: T): Promise<void> {
  await withStore(storeName, 'readwrite', (store) => requestResult(store.put(value)));
}

export async function deleteRecord(storeName: string, key: IDBValidKey): Promise<void> {
  await withStore(storeName, 'readwrite', (store) => requestResult(store.delete(key)));
}

export async function clearStore(storeName: string): Promise<void> {
  await withStore(storeName, 'readwrite', (store) => requestResult(store.clear()));
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

interface StoredCode {
  uuid: string;
  code: string;
}

export async function listScripts(includeRemoved = false): Promise<UserScript[]> {
  const scripts = await getAll<UserScript>('scripts');
  const result = includeRemoved ? scripts : scripts.filter((script) => !script.removedAt);
  return result.sort((a, b) => a.sort - b.sort || b.updatedAt - a.updatedAt);
}

export async function getScript(uuid: string): Promise<UserScript | undefined> {
  return getRecord<UserScript>('scripts', uuid);
}

export async function getScriptCode(uuid: string): Promise<string | undefined> {
  return (await getRecord<StoredCode>('code', uuid))?.code;
}

export async function getScriptWithCode(
  uuid: string,
): Promise<(UserScript & { code: string }) | undefined> {
  const [script, code] = await Promise.all([getScript(uuid), getScriptCode(uuid)]);
  return script && code !== undefined ? { ...script, code } : undefined;
}

export async function findByNameNamespace(
  name: string,
  namespace: string,
  includeRemoved = true,
): Promise<UserScript | undefined> {
  const scripts = await listScripts(includeRemoved);
  return scripts.find((script) => script.name === name && script.namespace === namespace);
}

export async function saveScript(
  script: UserScript,
  code: string,
  options: { snapshot?: boolean } = {},
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['scripts', 'code', 'versions'], 'readwrite');
  const scripts = tx.objectStore('scripts');
  const codes = tx.objectStore('code');
  const versions = tx.objectStore('versions');

  scripts.put(script);
  codes.put({ uuid: script.uuid, code });
  if (options.snapshot !== false) {
    const version: ScriptVersion = {
      id: `${script.uuid}:${Date.now()}`,
      uuid: script.uuid,
      code,
      metadata: script.metadata,
      createdAt: Date.now(),
    };
    versions.put(version);
  }

  await txDone(tx);
}

export async function setScriptEnabled(uuid: string, enabled: boolean): Promise<void> {
  const script = await getScript(uuid);
  if (!script) return;
  await putRecord('scripts', { ...script, enabled, updatedAt: Date.now() });
}

export async function moveScriptToTrash(uuid: string): Promise<void> {
  const script = await getScript(uuid);
  if (!script) return;
  await putRecord('scripts', { ...script, removedAt: Date.now(), enabled: false, updatedAt: Date.now() });
}

export async function restoreScript(uuid: string): Promise<void> {
  const script = await getScript(uuid);
  if (!script) return;
  const { removedAt: _removedAt, ...rest } = script;
  await putRecord('scripts', { ...rest, enabled: true, updatedAt: Date.now() });
}

export async function purgeScript(uuid: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['scripts', 'code', 'versions', 'resources', 'icons'], 'readwrite');
  tx.objectStore('scripts').delete(uuid);
  tx.objectStore('code').delete(uuid);
  tx.objectStore('versions').delete(uuid);
  tx.objectStore('resources').delete(IDBKeyRange.bound([uuid, ''], [uuid, '\uffff']));
  tx.objectStore('icons').delete(uuid);
  await txDone(tx);
}

export async function listVersions(uuid: string): Promise<ScriptVersion[]> {
  const versions = await getAll<ScriptVersion>('versions');
  return versions.filter((version) => version.uuid === uuid).sort((a, b) => b.createdAt - a.createdAt);
}

export async function recordRun(uuid: string, error?: string): Promise<void> {
  const script = await getScript(uuid);
  if (!script) return;
  await putRecord('scripts', {
    ...script,
    lastRunAt: Date.now(),
    runCount: (script.runCount ?? 0) + 1,
    lastError: error,
  });
}

export async function updateScriptPartial(
  uuid: string,
  patch: Partial<UserScript>,
): Promise<UserScript | undefined> {
  const script = await getScript(uuid);
  if (!script) return undefined;
  const next = { ...script, ...patch, updatedAt: Date.now() };
  await putRecord('scripts', next);
  return next;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

interface StoredValue {
  storageName: string;
  key: string;
  value: unknown;
}

export async function getValues(storageName: string): Promise<Record<string, unknown>> {
  const rows = await getAll<StoredValue>('values');
  const values: Record<string, unknown> = Object.create(null);
  for (const row of rows) {
    if (row.storageName === storageName) values[row.key] = row.value;
  }
  return values;
}

export async function setStoredValue(storageName: string, key: string, value: unknown): Promise<void> {
  await putRecord<StoredValue>('values', { storageName, key, value });
}

export async function deleteStoredValue(storageName: string, key: string): Promise<void> {
  await deleteRecord('values', [storageName, key]);
}

export async function listValueKeys(storageName: string): Promise<string[]> {
  return Object.keys(await getValues(storageName));
}

export async function deleteValuesForStorage(storageName: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('values', 'readwrite');
  tx.objectStore('values').delete(IDBKeyRange.bound([storageName, ''], [storageName, '\uffff']));
  await txDone(tx);
}

// ---------------------------------------------------------------------------
// Script icons
// ---------------------------------------------------------------------------

export async function getScriptIcon(uuid: string): Promise<ScriptIconCache | undefined> {
  return getRecord<ScriptIconCache>('icons', uuid);
}

export async function listScriptIcons(): Promise<ScriptIconCache[]> {
  return getAll<ScriptIconCache>('icons');
}

export async function putScriptIcon(icon: ScriptIconCache): Promise<void> {
  await putRecord('icons', icon);
}

export async function deleteScriptIcon(uuid: string): Promise<void> {
  await deleteRecord('icons', uuid);
}

export async function clearScriptIcons(): Promise<void> {
  await clearStore('icons');
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export async function getResources(uuid: string): Promise<StoredResource[]> {
  const rows = await getAll<StoredResource>('resources');
  return rows.filter((row) => row.uuid === uuid);
}

export async function replaceResources(uuid: string, resources: StoredResource[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('resources', 'readwrite');
  const store = tx.objectStore('resources');
  store.delete(IDBKeyRange.bound([uuid, ''], [uuid, '\uffff']));
  for (const resource of resources) store.put(resource);
  await txDone(tx);
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export async function addLog(entry: LogEntry): Promise<void> {
  await putRecord('logs', { ...entry, time: entry.time || Date.now() });
}

export async function listLogs(limit = 500, uuid?: string): Promise<LogEntry[]> {
  const entries = await getAll<LogEntry>('logs');
  return entries
    .filter((entry) => !uuid || entry.uuid === uuid)
    .sort((a, b) => b.time - a.time)
    .slice(0, limit);
}

export async function clearLogs(uuid?: string): Promise<void> {
  if (!uuid) {
    await clearStore('logs');
    return;
  }
  const entries = await getAll<LogEntry>('logs');
  const db = await openDb();
  const tx = db.transaction('logs', 'readwrite');
  for (const entry of entries) {
    if (entry.uuid === uuid && entry.id !== undefined) tx.objectStore('logs').delete(entry.id);
  }
  await txDone(tx);
}

// ---------------------------------------------------------------------------
// Install drafts
// ---------------------------------------------------------------------------

export interface InstallDraftRecord extends InstallDraftSummary {
  expiresAt: number;
  draftUuid: string;
  metadata: ScriptMetadata;
  selfMetadata?: ScriptMetadata;
  resourceRecords?: import('@/types').StoredResource[];
}

export async function putDraft(draft: InstallDraftRecord): Promise<void> {
  await putRecord('drafts', draft);
}

export async function getDraft(token: string): Promise<InstallDraftRecord | undefined> {
  const draft = await getRecord<InstallDraftRecord>('drafts', token);
  if (!draft) return undefined;
  if (draft.expiresAt < Date.now()) {
    await deleteRecord('drafts', token);
    return undefined;
  }
  return draft;
}

export async function deleteDraft(token: string): Promise<void> {
  await deleteRecord('drafts', token);
}

export async function cleanupDrafts(): Promise<void> {
  const drafts = await getAll<InstallDraftRecord>('drafts');
  const now = Date.now();
  const db = await openDb();
  const tx = db.transaction('drafts', 'readwrite');
  const expired: InstallDraftRecord[] = [];
  for (const draft of drafts) {
    if (draft.expiresAt < now) {
      expired.push(draft);
      tx.objectStore('drafts').delete(draft.token);
    }
  }
  await txDone(tx);
  for (const draft of expired) {
    await replaceResources(draft.draftUuid, []);
  }
}
