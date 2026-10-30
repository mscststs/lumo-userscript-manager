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

export function hasWriteGrant(grants: string[] | undefined): boolean {
  return (grants ?? []).some((grant) =>
    ['GM_setValue', 'GM.setValue', 'GM_deleteValue', 'GM.deleteValue'].includes(grant),
  );
}
