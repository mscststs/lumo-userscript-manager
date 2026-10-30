# Lumo Userscripts

A powerful, well-crafted userscript manager for Chrome. Built on the same WXT + React 19 + Tailwind CSS 4 + shadcn/ui foundation as [Lumo](https://github.com/mscststs/lumo).

Chrome MV3 only. Minimum Chrome version: **138** (the “Allow User Scripts” toggle generation).

- Repository: <https://github.com/mscststs/lumo-userscript-manager>
- Issues: <https://github.com/mscststs/lumo-userscript-manager/issues>

## Features

- Install userscripts from a URL, file, clipboard, or the dashboard
- `chrome.userScripts`-based injection in the MAIN world or USER_SCRIPT sandbox
- MAIN ↔ USER_SCRIPT bridge with per-registration tokens
- `@match` / `@include` / `@exclude` / `@exclude-match` compilation, including glob and regex rules
- `@grant` support for the common GM API surface:
  - values, value-change listeners
  - `GM_xmlhttpRequest`, `GM_cookie`, `GM_download`, `GM_notification`
  - `GM_closeNotification`, `GM_updateNotification`, `GM_openInTab`, `GM_closeInTab`
  - `GM_addStyle`, `GM_addElement`, `GM_setClipboard`
  - `GM_registerMenuCommand`, `GM_getTab` / `GM_saveTab` / `GM_getTabs`
  - `unsafeWindow`, `window.close` / `window.focus`
  - `@require`, `@require-css` and `@resource`
- Relative `@require` / `@resource` / `@icon` / `@updateURL` / `@downloadURL` URLs resolved against the install URL
- Per-script enable/disable, metadata overrides, values editor, resource viewer
- CodeMirror 6 editor with metadata diagnostics
- Recycle bin, JSON/ZIP backup export and import
- Update checks with permission-aware auto-update
- Popup current-page controls and menu commands
- Logs, runtime health checks and registration diagnostics
- Light / dark / midnight themes, adjustable UI scale, English & Chinese UI

## Tech Stack

| Category | Technologies |
|----------|--------------|
| Framework | [WXT](https://wxt.dev) (Chrome Extension MV3) |
| UI | React 19, Tailwind CSS 4, shadcn/ui, Radix UI |
| Editor | CodeMirror 6 |
| Runtime | `chrome.userScripts` MAIN/USER_SCRIPT worlds |
| State | IndexedDB, Chrome Storage API |
| i18n | i18next + react-i18next |
| Build | Vite 7, TypeScript 5.9 |

### Design system

Every surface (popup, options, install) is built from one token layer and one theme
registry. The rules — type scale, OKLCH palettes, accents, contrast matrix, motion
curves, component states and the responsive/HiDPI/accessibility invariants — live in
[`docs/DESIGN.md`](docs/DESIGN.md). Tokens are implemented in
[`assets/globals.css`](assets/globals.css); palettes and accents are registered in
[`lib/theme-registry.ts`](lib/theme-registry.ts).

## Getting Started

### Prerequisites

- Node.js >= 22.22.2
- npm >= 10 (the lockfile is generated with npm 11; npm 9 fails to resolve this peer graph)

### Install

```bash
npm install
```

### Development

```bash
npm run dev
```

`predev` builds the page-world runtime bundles (`public/user-scripts/{runner,host}.js`) before WXT starts. Load `.output/chrome-mv3` in Chrome (`chrome://extensions` → Developer mode → Load unpacked), then enable **Allow User Scripts** for the extension.

### Build

```bash
npm run build
```

`prebuild` rebuilds the runtime bundles automatically. Output goes to `.output/chrome-mv3`.

### Package

```bash
npm run zip
```

### Type Check & Tests

```bash
npm run compile
npm test
```

The default test suite is hermetic (no browser). The MV3 transport also has a
real-Chrome regression suite that exercises both execution worlds, GM values,
menus, `@require`, and service-worker eviction:

```bash
npm run build
LUMO_E2E=1 npm test -- tests/integration
```

Set `CHROME_PATH` to override the Chrome/Chromium binary. The suite is skipped
unless `LUMO_E2E=1` is set, so CI runners without Chrome stay green.

## Project Structure

```
entrypoints/
  background.ts       # service worker: registration, install, updates, GM APIs
  popup/              # current-page quick controls
  options/            # script list, editor, settings, logs, about
  install/            # install confirmation page (DNR redirect target)
components/
  ui/                 # shadcn base components
  editor/             # CodeMirror editor
  layout/             # PageLayout / PageHeader / EmptyState
  settings/           # SectionNav / SettingsGroup / SettingRow
lib/
  theme-registry.ts   # palettes + accent presets (single source of truth)
  theme.ts            # apply/mirror appearance, first-paint contract
  script/             # metadata parser, URL rules, launcher compiler, semver
  runtime/            # shared engines + BridgeClient/BridgeServer transport
  background/         # registration, host RPC service, GM APIs, tokens
  db/                 # IndexedDB layer
  background/         # registration, install, updates, values, GM handlers
  backup.ts           # JSON/ZIP backup helpers
i18n/                 # en / zh resources
store/                # chrome.storage settings
types/                # shared types
```

### Runtime bundles

`scripts/build-runtime.mjs` builds `lib/runtime/runner.ts` and `lib/runtime/host.ts` as standalone IIFEs into `public/user-scripts/`. They are copied into the extension by WXT and registered with `chrome.userScripts.register({ file })`. They must remain dependency-free classic scripts (no ESM imports).

The Host ↔ Service Worker port is opened lazily, heartbeated while active, and bootstrap requests retry across MV3 worker restarts. Registration is skipped when the current `chrome.userScripts` set already matches, avoiding unnecessary teardown during page loads.

## Permissions

- `userScripts` — dynamic userscript registration
- `storage`, `unlimitedStorage` — settings and bounded metadata
- `tabs`, `activeTab`, `webNavigation`, `scripting` — tab/context handling and diagnostics
- `declarativeNetRequest` — redirect `*.user.js` navigations to the install page
- `cookies`, `downloads` — `GM_cookie` / `GM_download`
- `notifications`, `contextMenus`, `alarms`, `clipboardWrite` — GM API support and background jobs
- `<all_urls>` — userscripts run on pages the user configures

## unsafeWindow

`unsafeWindow` is available to every script:

- page world (`@grant none`, `@inject-into page`, or any script declaring `@grant unsafeWindow`) exposes the real page `window`;
- `@grant unsafeWindow` takes precedence over `forceSandbox` and `@inject-into content`, because the isolated world cannot provide a synchronous page object;
- a USER_SCRIPT script that does not declare `@grant unsafeWindow` gets the isolated world's `window`, matching Violentmonkey/ScriptCat behavior.

## Runtime transport

```text
userscript engine (MAIN or USER_SCRIPT)
  └─ BridgeClient — window MessageChannel, nonce handshake
       └─ content-script bridge (ISOLATED)
            ├─ chrome.runtime.sendMessage → RPC / bootstrap
            └─ chrome.runtime.connect    → pushed events (lazy, reconnecting)
                 └─ background host service
```

A few consequences worth knowing when debugging:

- The ISOLATED content script is the **only** extension context used by the
  runtime. Chromium (Chrome 156 included) may not deliver `chrome.runtime`
  messages from a `USER_SCRIPT` world even with `configureWorld({messaging:true})`,
  so the engines never call `chrome.runtime` directly.
- The handshake is lazy: pages with no matching userscript never connect the
  event port or wake the service worker.
- Every host RPC carries an HMAC runtime token scoped to the script UUID and
  world. The background verifies it and derives the tab/frame from the content
  script sender, so a page cannot call another script's GM APIs.
- The event port reconnects after service-worker eviction and emits
  `BRIDGE_RESUME`; engines replay menu registrations.

## Known limitations

- Network-rule editing is not implemented.
- The editor opens one script at a time (multiple options tabs can open different scripts).
- Cross-device sync is not implemented; use JSON/ZIP backup.
- `@background`, `@crontab`, and `@run-in` are not executed; the installer shows a warning instead of silently ignoring them.

## License

This project does not currently include a license file. All rights reserved.
