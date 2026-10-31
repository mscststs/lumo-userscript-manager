/**
 * Backup payload contract shared by the options UI and the service worker.
 *
 * Deliberately free of `fflate`: the service worker only needs to validate and
 * read a payload, while the ZIP codec is a UI-side concern. Keeping the
 * contract in its own module also gives the validator a single home so the two
 * sides can never disagree about what a "backup" is.
 */

export const BACKUP_FORMAT = 'lumo-userscripts';

export interface BackupScriptRef {
  uuid?: string;
  name?: string;
  namespace?: string;
  origin?: string;
  enabled?: boolean;
  removedAt?: number;
  selfMetadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BackupEntry {
  script?: BackupScriptRef;
  code?: string;
  values?: Record<string, unknown>;
  resources?: unknown[];
}

export interface BackupData {
  format?: string;
  version?: number;
  exportedAt?: string;
  settings?: Record<string, unknown>;
  scripts?: BackupEntry[];
  [key: string]: unknown;
}

export type BackupErrorCode =
  | 'invalid-json'
  | 'invalid-shape'
  | 'invalid-format'
  | 'zip-missing-manifest';

/**
 * Failure raised while reading a backup file. The UI maps `code` to a localised
 * sentence; the English `message` is only ever a diagnostic fallback.
 */
export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'BackupError';
    this.code = code;
  }
}

/** Structural validation. Throws `BackupError` instead of returning a flag so
 *  every caller is forced to surface the failure. */
export function validateBackupData(raw: unknown): BackupData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BackupError('invalid-shape');
  }
  const data = raw as BackupData;
  if (data.format !== BACKUP_FORMAT) throw new BackupError('invalid-format');
  if (!Array.isArray(data.scripts)) throw new BackupError('invalid-shape');
  return data;
}

export function parseBackupJson(text: string): BackupData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError('invalid-json');
  }
  return validateBackupData(raw);
}

export interface BackupSummary {
  scripts: number;
  enabled: number;
  disabled: number;
  trash: number;
  values: number;
  resources: number;
  hasSettings: boolean;
}

/** Counts what the preview dialog and the overview card need, without loading
 *  any script code into the page. */
export function summarizeBackup(data: BackupData): BackupSummary {
  const summary: BackupSummary = {
    scripts: 0,
    enabled: 0,
    disabled: 0,
    trash: 0,
    values: 0,
    resources: 0,
    hasSettings: false,
  };

  for (const entry of data.scripts ?? []) {
    summary.scripts += 1;
    if (entry?.script?.removedAt) summary.trash += 1;
    else if (entry?.script?.enabled === false) summary.disabled += 1;
    else summary.enabled += 1;

    const values = entry?.values;
    if (values && typeof values === 'object') summary.values += Object.keys(values).length;
    if (Array.isArray(entry?.resources)) summary.resources += entry.resources.length;
  }

  summary.hasSettings = Boolean(
    data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings),
  );
  return summary;
}
