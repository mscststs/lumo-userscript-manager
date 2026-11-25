import { getScript, getValues, setStoredValue, deleteStoredValue } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { getStorageName } from '@/lib/script/storage-name';
import { mergeMetadata } from '@/lib/script/metadata';
import { broadcastToHosts } from './host-ports';

export async function getValuesForScript(uuid: string): Promise<{
  storageName: string;
  values: Record<string, unknown>;
}> {
  const script = await getScript(uuid);
  if (!script) throw new AppError('script.notFound', undefined, 'Script not found.');
  const storageName = getStorageName({ ...script, metadata: mergeMetadata(script.metadata, script.selfMetadata) });
  return { storageName, values: await getValues(storageName) };
}

/**
 * Persist a value and broadcast it to every frame.
 *
 * The origin engine already emitted its own listener with `remote=false` when
 * the script called GM_setValue, so engines skip `originUuid`. Everything else
 * — sibling scripts sharing @storageName, other frames and other tabs —
 * receives the change with `remote=true`.
 */
export async function setValueForScript(
  uuid: string,
  key: string,
  value: unknown,
  options: { originUuid?: string } = {},
): Promise<void> {
  const script = await getScript(uuid);
  if (!script) throw new AppError('script.notFound', undefined, 'Script not found.');
  const storageName = getStorageName({ ...script, metadata: mergeMetadata(script.metadata, script.selfMetadata) });
  const values = await getValues(storageName);
  const oldValue = values[key];

  if (value === undefined) await deleteStoredValue(storageName, key);
  else await setStoredValue(storageName, key, value);

  broadcastToHosts({
    type: 'bg:event',
    event: 'value-changed',
    payload: {
      uuid,
      originUuid: options.originUuid ?? '',
      storageName,
      key,
      oldValue,
      newValue: value,
      remote: true,
    },
  });
}

/**
 * Batch write used by `GM_setValues` / `GM_deleteValues`.
 *
 * One storage read, concurrent writes, then one broadcast per changed key so
 * listeners (including sibling scripts sharing `@storageName`) see the same
 * `(key, oldValue, newValue)` shape as a single `GM_setValue`.
 */
export async function setValuesForScript(
  uuid: string,
  entries: Record<string, unknown>,
  options: { originUuid?: string } = {},
): Promise<void> {
  const script = await getScript(uuid);
  if (!script) throw new AppError('script.notFound', undefined, 'Script not found.');
  const storageName = getStorageName({ ...script, metadata: mergeMetadata(script.metadata, script.selfMetadata) });
  const values = await getValues(storageName);
  const changes: { key: string; oldValue: unknown; newValue: unknown }[] = [];
  await Promise.all(
    Object.entries(entries ?? {}).map(async ([key, value]) => {
      changes.push({ key, oldValue: values[key], newValue: value });
      if (value === undefined) await deleteStoredValue(storageName, key);
      else await setStoredValue(storageName, key, value);
    }),
  );
  for (const change of changes) {
    broadcastToHosts({
      type: 'bg:event',
      event: 'value-changed',
      payload: {
        uuid,
        originUuid: options.originUuid ?? '',
        storageName,
        key: change.key,
        oldValue: change.oldValue,
        newValue: change.newValue,
        remote: true,
      },
    });
  }
}

export async function deleteValueForScript(
  uuid: string,
  key: string,
  options: { originUuid?: string } = {},
): Promise<void> {
  await setValueForScript(uuid, key, undefined, options);
}
