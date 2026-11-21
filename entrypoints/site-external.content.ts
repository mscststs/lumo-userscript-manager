import { startSiteExposure } from '@/lib/site-integration/expose';

/**
 * Site integration, page-world half.
 *
 * Script sites detect a manager by probing `window.external`; the probe has to
 * live in the page's own realm, which is why this runs as a MAIN-world content
 * script rather than through the isolated bridge.
 *
 * Scoped to the two script sites that implement the probe. The probe is claimed
 * immediately (Greasy Fork only retries once, one second after load) and is
 * withdrawn as soon as the isolated side reports that Site detection is off, so
 * a disabled feature never answers a probe with an installed name or version.
 */
export default defineContentScript({
  matches: ['*://*.greasyfork.org/*', '*://*.sleazyfork.org/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    startSiteExposure();
  },
});
