/**
 * The grant surface implemented by the runtime.
 *
 * Keep this list in sync with the `define()` calls in
 * `lib/runtime/gm-api.ts`. Unknown grants are kept in metadata so a future
 * version can implement them, but the installer flags them instead of
 * silently pretending they work.
 */
const SUPPORTED_GRANTS = new Set([
  'none',
  'unsafeWindow',
  'GM_info',
  'GM_getValue',
  'GM_setValue',
  'GM_deleteValue',
  'GM_listValues',
  'GM_getValues',
  'GM_setValues',
  'GM_deleteValues',
  'GM_addValueChangeListener',
  'GM_removeValueChangeListener',
  'GM_log',
  'GM_addStyle',
  'GM_addElement',
  'GM_getResourceText',
  'GM_getResourceURL',
  'GM_getResourceUrl',
  'GM_registerMenuCommand',
  'GM_unregisterMenuCommand',
  'GM_notification',
  'GM_closeNotification',
  'GM_updateNotification',
  'GM_download',
  'GM_openInTab',
  'GM_closeInTab',
  'GM_setClipboard',
  'GM_xmlhttpRequest',
  'GM_cookie',
  'GM_getTab',
  'GM_saveTab',
  'GM_getTabs',
  'window.close',
  'window.focus',
  'window.onurlchange',
  'GM.getValue',
  'GM.setValue',
  'GM.deleteValue',
  'GM.listValues',
  'GM.getValues',
  'GM.setValues',
  'GM.deleteValues',
  'GM.addValueChangeListener',
  'GM.removeValueChangeListener',
  'GM.log',
  'GM.addStyle',
  'GM.addElement',
  'GM.getResourceText',
  'GM.getResourceURL',
  'GM.getResourceUrl',
  'GM.registerMenuCommand',
  'GM.unregisterMenuCommand',
  'GM.notification',
  'GM.closeNotification',
  'GM.updateNotification',
  'GM.download',
  'GM.openInTab',
  'GM.closeInTab',
  'GM.setClipboard',
  'GM.xmlHttpRequest',
  'GM.cookie',
  'GM.getTab',
  'GM.saveTab',
  'GM.getTabs',
  'GM.info',
]);

/** Canonicalize the two accepted names for the same grant. */
export function canonicalGrant(grant: string): string {
  const value = grant.trim();
  if (value === 'GM.getResourceUrl' || value === 'GM_getResourceUrl') return 'GM_getResourceURL';
  if (value === 'GM.getResourceURL' || value === 'GM_getResourceURL') return 'GM_getResourceURL';
  return value;
}

export function isSupportedGrant(grant: string): boolean {
  return SUPPORTED_GRANTS.has(canonicalGrant(grant));
}

export function unsupportedGrants(grants: string[] | undefined): string[] {
  return [...new Set((grants ?? []).map(canonicalGrant).filter((grant) => !isSupportedGrant(grant)))];
}

/**
 * Grants that actually apply, including the implicit ones derived from
 * `@run-at context-menu` (the only way such a script can be started).
 * Shared by the registration and the runtime authorization check so the two
 * can never disagree.
 */
export function effectiveGrants(
  metadata: { grant?: string[]; 'run-at'?: string[] },
): string[] {
  const grants = metadata.grant?.length ? [...metadata.grant] : ['none'];
  if (metadata['run-at']?.[0] !== 'context-menu') return grants;
  if (grants.includes('none')) return ['GM_registerMenuCommand'];
  if (!grants.includes('GM_registerMenuCommand')) grants.push('GM_registerMenuCommand');
  return grants;
}

/**
 * Does `grant` cover the API name the background is about to run?
 *
 * Both spellings are accepted (`GM_xmlhttpRequest` / `GM.xmlHttpRequest`), the
 * same way the runtime exposes them.
 */
export function isApiGranted(api: string, grants: string[] | undefined): boolean {
  const normalized = new Set((grants ?? ['none']).map(canonicalGrant));
  const candidates = api.startsWith('GM_') ? [api, `GM.${api.slice(3)}`] : [api];
  return candidates.some((candidate) => normalized.has(canonicalGrant(candidate)));
}

export function hasWriteGrant(grants: string[] | undefined): boolean {
  return (grants ?? []).some((grant) =>
    [
      'GM_setValue',
      'GM.setValue',
      'GM_setValues',
      'GM.setValues',
      'GM_deleteValue',
      'GM.deleteValue',
      'GM_deleteValues',
      'GM.deleteValues',
    ].includes(grant),
  );
}
