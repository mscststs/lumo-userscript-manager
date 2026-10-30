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
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname),
      },
    },
  }),
});
