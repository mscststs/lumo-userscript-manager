import type { ScriptMetadata, UserScript } from '@/types';

export function getStorageName(script: Pick<UserScript, 'uuid'> & { metadata?: ScriptMetadata }): string {
  const declared = script.metadata?.storagename?.[0];
  return declared?.trim() || script.uuid;
}
