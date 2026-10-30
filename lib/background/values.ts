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

export async function setValueForScript(
  uuid: string,
  key: string,
  value: unknown,
  origin?: { tabId: number; frameId: number },
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
      origin: uuid,
      storageName,
      key,
      oldValue,
      newValue: value,
      remote: true,
    },
  }, origin);
}

export async function deleteValueForScript(
  uuid: string,
  key: string,
  origin?: { tabId: number; frameId: number },
): Promise<void> {
  await setValueForScript(uuid, key, undefined, origin);
}
