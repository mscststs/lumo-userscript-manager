import { findByNameNamespace, listScripts } from '@/lib/db';
import {
  isSupportedSiteHost,
  scriptSiteKey,
  siteHostOf,
  type SiteLookupResult,
} from '@/lib/site-integration/protocol';
import { storage } from '@/store/storage';

const NOT_INSTALLED: SiteLookupResult = { installed: false };

/**
 * Answer a script site's "is this installed?" probe.
 *
 * The site sends the name and namespace it displays, which can drift from the
 * installed copy: Greasy Fork publishes the current `@name`, while the local
 * copy may predate a rename or carry a localized main name. The numeric script
 * id in the page URL is stable, so name matching runs first (cheap, indexed
 * lookup) and the URL identity is the fallback (one table scan, only when the
 * name no longer matches).
 */
export async function lookupInstalledScript(input: {
  name?: unknown;
  namespace?: unknown;
  pageUrl?: unknown;
}): Promise<SiteLookupResult> {
  const pageUrl = typeof input.pageUrl === 'string' ? input.pageUrl : '';
  const host = siteHostOf(pageUrl);
  // Defence in depth: the page script only runs on supported hosts, but this
  // message must never turn into a general "what is installed?" endpoint for
  // any document that can reach the bridge.
  if (!host || !isSupportedSiteHost(host)) return NOT_INSTALLED;

  // The page-world gate is an optimisation, not the authority: any script in a
  // supported page can speak the bridge protocol directly. The settings read is
  // what actually keeps a disabled feature from answering.
  const settings = await storage.getUISettings();
  if (!settings.siteIntegration) return NOT_INSTALLED;

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const namespace = typeof input.namespace === 'string' ? input.namespace.trim() : '';

  if (name) {
    // `includeRemoved: false` — a script in the recycle bin is not installed as
    // far as the site is concerned; it must keep offering a fresh install.
    const exact = await findByNameNamespace(name, namespace, false);
    if (exact) return installed(exact.version);
  }

  const key = scriptSiteKey(pageUrl);
  if (!key) return NOT_INSTALLED;
  for (const script of await listScripts(false)) {
    const sources = [script.origin, script.downloadUrl, script.updateUrl];
    if (sources.some((url) => scriptSiteKey(url) === key)) return installed(script.version);
  }

  return NOT_INSTALLED;
}

function installed(version: string | undefined): SiteLookupResult {
  return version ? { installed: true, version } : { installed: true };
}
