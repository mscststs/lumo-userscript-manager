import { getScript, getValues, setStoredValue, deleteStoredValue } from '@/lib/db';
import { getStorageName } from '@/lib/script/storage-name';
import { mergeMetadata } from '@/lib/script/metadata';
import { broadcastToHosts } from './host-ports';

export async function getValuesForScript(uuid: string): Promise<{
  storageName: string;
  values: Record<string, unknown>;
}> {
  const script = await getScript(uuid);
  if (!script) throw new Error('Script not found.');
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
  if (!script) throw new Error('Script not found.');
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

export async function deleteValueForScript(
  uuid: string,
  key: string,
  options: { originUuid?: string } = {},
): Promise<void> {
  await setValueForScript(uuid, key, undefined, options);
}
