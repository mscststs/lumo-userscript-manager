import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import {
  BACKUP_FORMAT,
  BackupError,
  parseBackupJson,
  summarizeBackup,
  validateBackupData,
  type BackupData,
} from '@/lib/backup-format';
import { createBackupZip, readBackupZip } from '@/lib/backup';

function sampleBackup(): BackupData {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: '2026-01-02T03:04:05.000Z',
    settings: { language: 'zh', themeMode: 'dark' },
    scripts: [
      {
        script: { uuid: 'a', name: 'Enabled', enabled: true },
        code: '// ==UserScript==\n// @name Enabled\n// ==/UserScript==\n',
        values: { one: 1, two: 2 },
        resources: [{ url: 'https://example.com/a.css' }],
      },
      {
        script: { uuid: 'b', name: 'Disabled', enabled: false },
        code: '// ==UserScript==\n// @name Disabled\n// ==/UserScript==\n',
      },
      {
        script: { uuid: 'c', name: 'Deleted', removedAt: 123 },
        code: '// ==UserScript==\n// @name Deleted\n// ==/UserScript==\n',
      },
    ],
  };
}

describe('backup format', () => {
  it('rejects payloads that are not a backup object', () => {
    expect(() => validateBackupData(null)).toThrow(BackupError);
    expect(() => validateBackupData([])).toThrow(BackupError);
    expect(() => validateBackupData({ format: 'other', scripts: [] })).toThrowError(
      expect.objectContaining({ code: 'invalid-format' }),
    );
    expect(() => validateBackupData({ format: BACKUP_FORMAT })).toThrowError(
      expect.objectContaining({ code: 'invalid-shape' }),
    );
  });

  it('wraps malformed JSON in a coded error', () => {
    expect(() => parseBackupJson('{ nope')).toThrowError(
      expect.objectContaining({ code: 'invalid-json' }),
    );
  });

  it('accepts a structurally valid payload', () => {
    const data = sampleBackup();
    expect(validateBackupData(data)).toBe(data);
    expect(parseBackupJson(JSON.stringify(data)).scripts).toHaveLength(3);
  });

  it('summarises script states, values and resources', () => {
    expect(summarizeBackup(sampleBackup())).toEqual({
      scripts: 3,
      enabled: 1,
      disabled: 1,
      trash: 1,
      values: 2,
      resources: 1,
      hasSettings: true,
    });
  });

  it('treats a settings block that is not an object as absent', () => {
    const data = sampleBackup();
    data.settings = undefined;
    expect(summarizeBackup(data).hasSettings).toBe(false);
  });
});

describe('ZIP backup', () => {
  it('round-trips the payload and writes readable script files', () => {
    const data = sampleBackup();
    const zip = createBackupZip(data);
    const files = unzipSync(zip);

    expect(Object.keys(files)).toContain('backup.json');
    expect(Object.keys(files)).toContain('README.txt');
    expect(Object.keys(files)).toContain('scripts/Enabled-a.user.js');

    const restored = readBackupZip(new Uint8Array(zip).buffer as ArrayBuffer);
    expect(restored.format).toBe(BACKUP_FORMAT);
    expect(restored.scripts).toHaveLength(3);
    expect(restored.scripts?.[0]?.values).toEqual({ one: 1, two: 2 });
  });

  it('reports a ZIP without backup.json', () => {
    const zip = zipSync({ 'README.txt': strToU8('nothing here') });
    expect(() => readBackupZip(new Uint8Array(zip).buffer as ArrayBuffer)).toThrowError(
      expect.objectContaining({ code: 'zip-missing-manifest' }),
    );
  });

  it('reports a file that is not a ZIP at all', () => {
    expect(() => readBackupZip(strToU8('not a zip').buffer as ArrayBuffer)).toThrowError(
      expect.objectContaining({ code: 'invalid-shape' }),
    );
  });
});
