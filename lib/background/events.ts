/**
 * Background → extension-page events.
 *
 * Fire-and-forget: every open extension page (options, popup, install) hears
 * the event through `onLumoEvent`; with none open, `sendMessage` rejects and
 * the rejection is dropped on purpose.
 */
export function broadcast(event: string, payload: Record<string, unknown> = {}): void {
  void chrome.runtime.sendMessage({ type: 'lumo:event', event, payload }).catch(() => undefined);
}

const LOGS_COALESCE_MS = 1000;
let logsTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Tell open pages the log store changed.
 *
 * A script logging in a loop writes hundreds of entries a second; one event per
 * write would make every open log view and the sidebar badge re-query as fast
 * as the script can print. Writes inside a one-second window share a single
 * event, sent at the end of the window so it covers all of them.
 */
export function announceLogsChanged(): void {
  if (logsTimer !== undefined) return;
  logsTimer = setTimeout(() => {
    logsTimer = undefined;
    broadcast('logs-changed');
  }, LOGS_COALESCE_MS);
}
