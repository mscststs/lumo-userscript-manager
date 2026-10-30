# Lumo Userscripts

A Chrome MV3 userscript manager built with WXT, React 19 and Tailwind CSS 4.

- Chrome 138+ — requires **Allow User Scripts** for the extension
- Repository: <https://github.com/mscststs/lumo-userscript-manager>
- Issues: <https://github.com/mscststs/lumo-userscript-manager/issues>
- License: [MIT](LICENSE)

## Features

- Install from a URL, a file, or the dashboard
- `@match` / `@include` / `@exclude` / `@exclude-match`, including glob and regex rules
- Per-script `chrome.userScripts` registration in the MAIN world or a USER_SCRIPT sandbox
- GM API: values, `GM_xmlhttpRequest`, cookies, downloads, notifications, menu commands,
  styles, elements, clipboard, tab state, `unsafeWindow`, and `GM.*` aliases
- `@require`, `@require-css` and `@resource`, with relative URLs resolved against the install source
- CodeMirror 6 editor with metadata validation, overrides, values editor and resource viewer
- Recycle bin, JSON/ZIP backup export and import
- Update checks with permission-aware auto-update
- Popup page controls, logs, runtime health and registration diagnostics
- Three palettes (Paper / Graphite / Midnight) × five accents, adjustable UI scale, English and Chinese

## Requirements

- Node.js >= 22.22.2
- npm >= 10

## Development

```bash
npm install
npm run dev     # predev builds the runtime bundles first
```

Load `.output/chrome-mv3` via `chrome://extensions` → Developer mode → Load unpacked,
then enable **Allow User Scripts** for the extension.

```bash
npm run build   # production build → .output/chrome-mv3
npm run zip     # distributable archive
npm run compile # TypeScript check
npm test        # hermetic test suite
```

The MV3 transport also has a real-Chrome regression suite:

```bash
LUMO_E2E=1 npm test -- tests/integration
```

Set `CHROME_PATH` to override the Chrome/Chromium binary.

## Architecture

```
Service Worker            registration, storage, updates, privileged GM APIs
  ├─ us-runner            MAIN world engine
  ├─ us-host              USER_SCRIPT engine
  └─ per-script launchers chrome.userScripts

ISOLATED content bridge   the only runtime component that calls chrome.runtime
```

Pages run one of two engines; both talk to the bridge over a `MessageChannel`
with a nonce handshake. Every host RPC carries an HMAC token scoped to the script
UUID and world. See [`docs/USERSCRIPT_MANAGER_DESIGN.md`](docs/USERSCRIPT_MANAGER_DESIGN.md)
for the full model.

UI tokens, palettes, component rules and the design rationale live in
[`docs/DESIGN.md`](docs/DESIGN.md).

### Project structure

```
entrypoints/
  background.ts   service worker
  popup/          per-page controls
  options/        scripts, editor, logs, settings, appearance, about
  install/        install confirmation (DNR redirect target)
components/       ui primitives, editor, layout, settings
lib/
  script/         metadata parser, URL rules, launcher compiler
  runtime/        engines, GM API, bridge transport
  background/     registration, host service, updates, tokens
  db/             IndexedDB layer
  theme*.ts       palettes, accents, first-paint contract
i18n/             en / zh
store/            chrome.storage settings
types/            shared types
```

`scripts/build-runtime.mjs` compiles `lib/runtime/{runner,host}.ts` into standalone
IIFEs at `public/user-scripts/`; they must stay dependency-free classic scripts.

## unsafeWindow

- `@grant unsafeWindow` forces the MAIN world and exposes the real page `window`.
- `@inject-into page` and `@grant none` scripts also run in the page world.
- USER_SCRIPT scripts get the isolated world's `window`; they cannot provide a synchronous page object.

## Permissions

| Permission | Why |
| --- | --- |
| `userScripts` | Dynamic script registration |
| `storage`, `unlimitedStorage` | Settings and bounded metadata |
| `tabs`, `activeTab`, `webNavigation`, `scripting` | Tab context and diagnostics |
| `declarativeNetRequest` | Redirect `.user.js` navigations to the install page |
| `cookies`, `downloads` | `GM_cookie`, `GM_download` |
| `notifications`, `contextMenus`, `alarms`, `clipboardWrite` | GM APIs and background jobs |
| `<all_urls>` | Userscripts run where the user configures them |

## Known limitations

- Network-rule editing is not implemented.
- One script per editor at a time.
- Cross-device sync is not implemented; use JSON/ZIP backup.
- `@background`, `@crontab` and `@run-in` are not executed; the installer warns instead of ignoring them silently.

## License

[MIT](LICENSE)
