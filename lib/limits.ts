/** Shared hard limits for data that crosses an untrusted boundary. */
export const MAX_SCRIPT_BYTES = 5 * 1024 * 1024;
export const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_BACKUP_JSON_BYTES = 50 * 1024 * 1024;
export const MAX_BACKUP_ZIP_BYTES = 200 * 1024 * 1024;
export const MAX_BACKUP_SCRIPTS = 1000;
export const MAX_BACKUP_RESOURCES_PER_SCRIPT = 1000;
export const MAX_BACKUP_VALUES_PER_SCRIPT = 10_000;
