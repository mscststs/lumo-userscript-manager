# Lumo Userscripts

A Chromium MV3 userscript manager for Chrome and Edge, built with WXT, React 19 and Tailwind CSS 4.

- Chrome 138+ or Edge 138+ — requires **Allow User Scripts** for the extension
- Repository: <https://github.com/mscststs/lumo-userscript-manager>
- Issues: <https://github.com/mscststs/lumo-userscript-manager/issues>
- Privacy: [PRIVACY.md](PRIVACY.md)
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
- Optional site compatibility: Greasy Fork and Sleazy Fork can show whether a
  script is installed and offer the right update or reinstall button
- Popup page controls, logs, runtime health and registration diagnostics
- Three palettes (Paper / Graphite / Midnight) × five accents, adjustable UI scale, English, Chinese and more

## Requirements

- Node.js >= 22.22.2
- npm >= 10

## Development

```bash
npm install
npm run dev     # predev builds the runtime bundles first
```

Load the unpacked build in either browser — the same Chrome package runs in
Edge, which maps `chrome://` routes to `edge://`:

| Browser | Build | Load via |
| --- | --- | --- |
| Chrome | `.output/chrome-mv3` | `chrome://extensions` → Developer mode → Load unpacked |
| Edge | `.output/chrome-mv3` | `edge://extensions` → Developer mode → Load unpacked |

Then enable **Allow User Scripts** for the extension.

```bash
npm run build   # production build → .output/chrome-mv3
npm run zip     # distributable archive for both stores
npm run compile # TypeScript check
npm test        # hermetic test suite
```

The MV3 transport also has a real-browser regression suite. It loads the
Chrome build; `CHROME_PATH` may point at any Chromium binary that can load it
(Chrome, Edge, Chromium):

```bash
LUMO_E2E=1 npm test -- tests/integration
```

Set `CHROME_PATH` to override the Chrome/Chromium/Edge binary (default
`google-chrome`).

### Releasing to the Chrome Web Store

Publishing is tag-driven and does not run on ordinary pushes to `main`:

1. Bump `version` in `package.json`.
2. Commit the change.
3. Push a matching tag, e.g. `git tag v1.0.4 && git push origin v1.0.4`.

The [Publish workflow](../../actions/workflows/publish.yml) then builds the
package once, type-checks it, verifies that the tag, `package.json` and the
zip's `manifest.json` all agree, and publishes that one zip to both the Chrome
Web Store and the Microsoft Edge Add-ons listing. The version must also be
greater than the one already published on each store.

The workflow reads five repository secrets:

| Secret | Where it comes from |
| --- | --- |
| `CHROME_CLIENT_ID` | Google Cloud OAuth client (Chrome Web Store API enabled) |
| `CHROME_CLIENT_SECRET` | Same OAuth client |
| `CHROME_REFRESH_TOKEN` | OAuth consent flow for scope `https://www.googleapis.com/auth/chromewebstore` |
| `CHROME_PUBLISHER_ID` | Developer dashboard URL: `publishers/<publisher id>/items/...` |
| `CHROME_ITEM_ID` | The 32-character extension id in the dashboard URL |

Manual runs from the Actions tab support `publish`, `upload` (no review
submission), and `status` (read-only); `skip_upload` is a recovery switch for
retrying only the publish step after an upload succeeded. The same checks are
available locally without consuming a submission:

```bash
npm run zip
node scripts/release/cws-publish.mjs --mode check
node scripts/release/cws-publish.mjs --mode status   # needs the CHROME_* env vars
node scripts/release/cws-publish.mjs --mode publish --skip-upload  # recovery only
```

### Releasing to the Microsoft Edge Add-ons

The same tag publishes the same zip to Microsoft Edge Add-ons right after the
Chrome submission, through the Edge Add-ons v1.1 API (`ApiKey` + `X-ClientID`).
It reads three more repository secrets:

| Secret | Where it comes from |
| --- | --- |
| `EDGE_API_KEY` | Partner Center → Microsoft Edge → **Publish API** → API keys |
| `EDGE_CLIENT_ID` | Same page, the Client ID shown next to the keys |
| `EDGE_PRODUCT_ID` | Partner Center → Microsoft Edge → **Overview** → Product ID (a GUID) |

`EDGE_PRODUCT_ID` must be the Partner Center product GUID. The 32-character id
in the store URL is the extension id, not the product id: the script reads
`EDGE_CRX_ID` only as a fallback and refuses it, because the endpoint accepts
nothing but a GUID.

Edge has no read-only status endpoint, so the manual `status` mode degrades to
the local package check there. `skip_upload` still applies: it re-submits the
draft the store already holds, which is the recovery path after a failed
publish.

```bash
npm run zip
node scripts/release/edge-publish.mjs --mode check
EDGE_API_KEY=… EDGE_CLIENT_ID=… EDGE_PRODUCT_ID=… \
  node scripts/release/edge-publish.mjs --mode upload --expected-version v1.0.6
EDGE_API_KEY=… EDGE_CLIENT_ID=… EDGE_PRODUCT_ID=… \
  node scripts/release/edge-publish.mjs --mode publish --skip-upload  # recovery only
```

The listing copy for both stores lives in [`docs/STORE_LISTING.md`](docs/STORE_LISTING.md).

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
  site-external   page-world script-site probe (MAIN world, opt-in)
  site-state      opt-in publisher for the probe (ISOLATED world)
components/       ui primitives, editor, layout, settings
lib/
  script/         metadata parser, URL rules, launcher compiler
  runtime/        engines, GM API, bridge transport
  site-integration/  script-site probe contract, exposure and opt-in channel
  background/     registration, host service, updates, tokens
  db/             IndexedDB layer
  theme*.ts       palettes, accents, first-paint contract
i18n/             locale registry, JSON bundles, manifest copy
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
| `storage`, `unlimitedStorage` | Settings plus the IndexedDB quota that holds script bodies, revisions and logs |
| `tabs`, `webNavigation` | Badge counts, popup tab context, `GM_openInTab` and navigation commits |
| `declarativeNetRequest` | Redirect `.user.js` navigations to the install page |
| `cookies`, `downloads` | `GM_cookie`, `GM_download` |
| `notifications`, `alarms`, `clipboardWrite` | GM APIs and background jobs |
| `<all_urls>` | Userscripts run where the user configures them |

`scripting`, `activeTab` and `contextMenus` are intentionally not requested: userscripts are injected through `userScripts` plus the static bridge content script, `<all_urls>` already covers tab access, and `GM_registerMenuCommand` is surfaced in the popup rather than the browser context menu. `tests/manifest-permissions.test.ts` fails if a declared permission loses its last caller or one of these three comes back.

`externally_connectable` lets the Agent/MCP endpoint receive runtime ports from
other extensions. It is deny-by-default: `lib/agent/policy.ts` only authorizes
extension IDs the user explicitly allows in Settings → Agent.

## Known limitations

- Network-rule editing is not implemented.
- One script per editor at a time.
- Cross-device sync is not implemented; use JSON/ZIP backup.
- `@background`, `@crontab` and `@run-in` are not executed; the installer warns instead of ignoring them silently.

## License

[MIT](LICENSE)
