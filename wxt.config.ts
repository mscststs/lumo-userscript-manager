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
    minimum_chrome_version: '138',
    permissions: [
      'storage',
      'unlimitedStorage',
      'tabs',
      'activeTab',
      'scripting',
      'userScripts',
      'webNavigation',
      'declarativeNetRequest',
      'cookies',
      'downloads',
      'notifications',
      'contextMenus',
      'alarms',
      'clipboardWrite',
    ],
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
