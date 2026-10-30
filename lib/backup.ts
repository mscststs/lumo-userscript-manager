import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

interface BackupEntry {
  script?: { uuid?: string; name?: string };
  code?: string;
}

interface BackupData {
  format?: string;
  version?: number;
  exportedAt?: string;
  scripts?: BackupEntry[];
  [key: string]: unknown;
}

function safeName(value: string): string {
  return value.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'script';
}

export function createBackupZip(data: BackupData): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'backup.json': strToU8(JSON.stringify(data, null, 2)),
    'README.txt': strToU8(
      'Lumo Userscripts backup\n\nbackup.json contains the full restore payload. The scripts/ folder is a human-readable copy.\n',
    ),
  };
  for (const entry of data.scripts ?? []) {
    if (!entry.script || !entry.code) continue;
    const name = safeName(entry.script.name ?? entry.script.uuid ?? 'script');
    const uuid = safeName(entry.script.uuid ?? 'script');
    files[`scripts/${name}-${uuid}.user.js`] = strToU8(entry.code);
  }
  return zipSync(files, { level: 6 });
}

export function readBackupZip(buffer: ArrayBuffer): BackupData {
  const files = unzipSync(new Uint8Array(buffer));
  const raw = files['backup.json'];
  if (!raw) throw new Error('The ZIP does not contain backup.json.');
  const data = JSON.parse(strFromU8(raw)) as BackupData;
  if (data.format !== 'lumo-userscripts') throw new Error('Unrecognized backup format.');
  return data;
}
