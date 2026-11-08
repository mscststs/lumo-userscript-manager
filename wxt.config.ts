import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { themePreloadPlugin } from './lib/build/theme-preload-plugin';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: {
    disabled: true,
  },
  manifest: {
    default_locale: 'en',
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    // Chrome and Edge share Chromium's version numbering, so this floor
    // applies to both store builds; the userScripts API needs it either way.
    minimum_chrome_version: '138',
    permissions: [
      // Settings, pointers and counters only (`store/storage.ts`).
      'storage',
      // Userscript bodies, revisions and logs live in IndexedDB (`lib/db`).
      'unlimitedStorage',
      // Badge counts, popup tab context and `GM_openInTab` (`lib/background`).
      'tabs',
      // Dynamic registration table for every installed userscript (`lib/script`).
      'userScripts',
      // Repaint/clear the badge on navigation commits (`entrypoints/background.ts`).
      'webNavigation',
      // Redirect `.user.js` navigations to the installer page (`entrypoints/background.ts`).
      'declarativeNetRequest',
      // `GM_cookie` (`lib/background/gm.ts`).
      'cookies',
      // `GM_download` (`lib/background/gm.ts`).
      'downloads',
      // `GM_notification` (`lib/background/gm.ts`).
      'notifications',
      // Background update checks (`lib/background/updates.ts`).
      'alarms',
      // `GM_setClipboard` and copying the extension id from settings.
      'clipboardWrite',
    ],
    // Deliberately absent, each removed after a Chrome Web Store review:
    //  - `scripting`: userscripts run through `userScripts` plus the static
    //    bridge content script, never through `chrome.scripting`.
    //  - `activeTab`: `<all_urls>` already grants the tab access the popup needs.
    //  - `contextMenus`: `GM_registerMenuCommand` surfaces in the popup menu,
    //    not in the browser context menu.
    host_permissions: ['<all_urls>'],
    // Agent hosts open an MCP session over a runtime Port (see lib/agent).
    // "*" is required because the host's unpacked ID differs per install;
    // `lib/agent/policy.ts` is the authoritative allowlist.
    externally_connectable: {
      ids: ['*'],
    },
    web_accessible_resources: [
      {
        resources: ['install.html'],
        matches: ['<all_urls>'],
      },
    ],
    action: {
      default_title: '__MSG_actionTitle__',
      default_popup: 'popup.html',
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
  },
  vite: () => ({
    plugins: [tailwindcss(), themePreloadPlugin()],
    build: {
      // Chrome refuses to reuse a `chrome-extension://` preload across script
      // worlds (Resource::CanReuse -> kCrossWorldExtensionResourceMismatch),
      // which produces a flood of "cross-world extension resource mismatch"
      // warnings. Extension resources are local reads, so modulepreload buys
      // no network round trip here.
      modulePreload: false,
      // The options bundle carries CodeMirror + Shiki; it is intentionally a
      // single local chunk (no network). The default 500 kB warning is noise
      // here, so keep a limit that still catches accidental growth.
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        onwarn(warning, warn) {
          // Zod v4 ships `@__PURE__` comments that Rollup 4 cannot interpret in
          // their position. The MCP SDK pulls zod in, so the warning appears on
          // every build even though the emitted code is correct.
          if (
            warning.code === 'INVALID_ANNOTATION' &&
            typeof warning.id === 'string' &&
            warning.id.includes('/node_modules/zod/')
          ) {
            return;
          }
          warn(warning);
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname),
      },
    },
  }),
});
