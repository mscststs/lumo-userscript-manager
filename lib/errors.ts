import type { TranslationKey } from '@/i18n/keys';

/**
 * Stable, user-facing failure codes.
 *
 * The service worker, IndexedDB and the installer all run without the user's
 * language. They report a code plus optional params; the React layer is the
 * only place that turns it into a sentence. The raw English message is kept as
 * `detail` for logs and the "technical details" disclosure — never as the
 * headline of a localized UI.
 */
export type ErrorCode =
  | 'background.requestFailed'
  | 'background.unknownMessage'
  | 'script.notFound'
  | 'script.codeMissing'
  | 'script.sourceRequired'
  | 'script.tooLarge'
  | 'script.duplicate'
  | 'script.invalidMetadata'
  | 'install.draftExpired'
  | 'install.tooLarge'
  | 'update.httpError'
  | 'update.downloadFailed'
  | 'value.scriptNotFound'
  | 'agent.disabled'
  | 'agent.notAllowlisted'
  | 'agent.writeDisabled'
  | 'agent.rateLimited'
  | 'agent.portClosed'
  | 'database.openFailed'
  | 'database.requestFailed'
  | 'database.transactionFailed'
  | 'runtime.apiUnavailable'
  | 'runtime.unexpectedResult'
  | 'runtime.disabled'
  | 'common.unknown';

/** Every code has exactly one translation key. */
export const ERROR_KEYS: Record<ErrorCode, TranslationKey> = {
  'background.requestFailed': 'errors.background.requestFailed',
  'background.unknownMessage': 'errors.background.unknownMessage',
  'script.notFound': 'errors.script.notFound',
  'script.codeMissing': 'errors.script.codeMissing',
  'script.sourceRequired': 'errors.script.sourceRequired',
  'script.tooLarge': 'errors.script.tooLarge',
  'script.duplicate': 'errors.script.duplicate',
  'script.invalidMetadata': 'errors.script.invalidMetadata',
  'install.draftExpired': 'errors.install.draftExpired',
  'install.tooLarge': 'errors.install.tooLarge',
  'update.httpError': 'errors.update.httpError',
  'update.downloadFailed': 'errors.update.downloadFailed',
  'value.scriptNotFound': 'errors.value.scriptNotFound',
  'agent.disabled': 'errors.agent.disabled',
  'agent.notAllowlisted': 'errors.agent.notAllowlisted',
  'agent.writeDisabled': 'errors.agent.writeDisabled',
  'agent.rateLimited': 'errors.agent.rateLimited',
  'agent.portClosed': 'errors.agent.portClosed',
  'database.openFailed': 'errors.database.openFailed',
  'database.requestFailed': 'errors.database.requestFailed',
  'database.transactionFailed': 'errors.database.transactionFailed',
  'runtime.apiUnavailable': 'errors.runtime.apiUnavailable',
  'runtime.unexpectedResult': 'errors.runtime.unexpectedResult',
  'runtime.disabled': 'errors.runtime.disabled',
  'common.unknown': 'errors.common.unknown',
};

export type ErrorParams = Record<string, string | number>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params?: ErrorParams;
  /** Raw technical text. Kept out of the localized headline. */
  readonly detail?: string;

  constructor(code: ErrorCode, params?: ErrorParams, detail?: string) {
    super(detail ?? code);
    this.name = 'AppError';
    this.code = code;
    this.params = params;
    this.detail = detail;
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_KEYS;
}

/** Serialise an error for the background → UI message channel. */
export function serializeError(error: unknown): {
  code: ErrorCode;
  message: string;
  params?: ErrorParams;
  detail?: string;
} {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      params: error.params,
      detail: error.detail,
    };
  }
  return {
    code: 'common.unknown',
    message: error instanceof Error ? error.message : String(error),
    detail: error instanceof Error ? error.stack : undefined,
  };
}

/** Rebuild an AppError from a background response. */
export function appErrorFromResponse(
  code: unknown,
  message: unknown,
  params?: unknown,
): AppError {
  const text = typeof message === 'string' ? message : undefined;
  if (isErrorCode(code)) {
    return new AppError(
      code,
      params && typeof params === 'object' ? (params as ErrorParams) : undefined,
      // When the worker had no richer text, `message` is just the code. Showing
      // that below the translated headline is noise, not a technical detail.
      text && text !== code ? text : undefined,
    );
  }
  return new AppError('background.requestFailed', undefined, text);
}
