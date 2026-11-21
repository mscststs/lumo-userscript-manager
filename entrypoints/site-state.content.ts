import { defaultSiteStateScope, startSiteStateChannel } from '@/lib/site-integration/state';

/**
 * Site integration, isolated-world half.
 *
 * The page-world script cannot read extension storage, so this content script
 * publishes the opt-in value to it. It only runs on the two script sites (the
 * bridge stays a pure transport for every other page) and does nothing unless
 * Settings → Compatibility → Site detection is on.
 */
export default defineContentScript({
  matches: ['*://*.greasyfork.org/*', '*://*.sleazyfork.org/*'],
  runAt: 'document_start',
  main() {
    startSiteStateChannel(defaultSiteStateScope());
  },
});
