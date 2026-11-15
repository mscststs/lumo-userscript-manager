import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  BackupError,
  parseBackupJson,
  type BackupData,
} from './backup-format';
import { MAX_BACKUP_JSON_BYTES, MAX_BACKUP_ZIP_BYTES } from './limits';

export type { BackupData } from './backup-format';

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
    if (!entry.script || typeof entry.code !== 'string') continue;
    const name = safeName(entry.script.name ?? entry.script.uuid ?? 'script');
    const uuid = safeName(entry.script.uuid ?? 'script');
    files[`scripts/${name}-${uuid}.user.js`] = strToU8(entry.code);
  }
  return zipSync(files, { level: 6 });
}

export function readBackupZip(buffer: ArrayBuffer): BackupData {
  if (buffer.byteLength > MAX_BACKUP_ZIP_BYTES) {
    throw new BackupError('invalid-shape', 'The backup archive is too large.');
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer), {
      // Only the manifest is needed; do not expand an attacker-controlled
      // `scripts/` tree or a zip bomb.
      filter: (file) =>
        file.name === 'backup.json' && file.originalSize <= MAX_BACKUP_JSON_BYTES,
    });
  } catch {
    throw new BackupError('invalid-shape', 'The file is not a readable ZIP archive.');
  }
  const raw = files['backup.json'];
  if (!raw) throw new BackupError('zip-missing-manifest');
  if (raw.byteLength > MAX_BACKUP_JSON_BYTES) {
    throw new BackupError('invalid-shape', 'The backup manifest is too large.');
  }
  return parseBackupJson(strFromU8(raw));
}
