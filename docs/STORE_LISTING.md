# Store Listing Copy

Source of truth for the Chrome Web Store and Microsoft Edge Add-ons listings.
Both stores accept their own forms, but keeping the copy here keeps the two
submissions consistent and reviewable in Git.

- Product name: **Lumo Userscripts**
- Manifest description: `__MSG_extDescription__` (see `public/_locales/`)
- Privacy policy: `PRIVACY.md` — publish it at a public URL before submitting
- Repository: <https://github.com/mscststs/lumo-userscript-manager>

## Shared positioning

Short descriptions stay browser-neutral (`browser`), because the same build
targets Chromium browsers and the stores already show the host browser. The
detailed descriptions name Chrome and Edge so users know the extension is
available for their browser.

## Chrome Web Store

### Name

Lumo Userscripts

### Short description (≤132 characters)

> A powerful, well-crafted userscript manager for your browser.

### Detailed description

> Lumo Userscripts is a fast, native userscript manager for Chrome and Edge.
>
> - Install from a URL, a file, or the dashboard
> - `@match` / `@include` / `@exclude` / `@exclude-match`, including glob and regex rules
> - Run scripts in the MAIN world or in an isolated USER_SCRIPT sandbox
> - GM API: values, `GM_xmlhttpRequest`, cookies, downloads, notifications, menu commands, styles, elements, clipboard, tab state and `unsafeWindow`
> - `@require`, `@require-css` and `@resource`, with relative URLs resolved against the install source
> - CodeMirror 6 editor with metadata validation, overrides, values editor and resource viewer
> - Recycle bin, JSON/ZIP backup export and import
> - Permission-aware update checks with automatic installation
> - Popup controls, execution logs, runtime health and registration diagnostics
> - Three palettes × five accents, adjustable UI scale, English and Chinese
>
> Everything stays on your device. No telemetry, no account, no cloud sync.
> Source code and issues: <https://github.com/mscststs/lumo-userscript-manager>

### Category

Developer Tools

### Permission justifications

| Permission | Justification |
| --- | --- |
| `userScripts` | The core feature: registering and running the userscripts the user installs. |
| `storage`, `unlimitedStorage` | Persist settings, bounded metadata and the IndexedDB data that holds script bodies, revisions and logs. |
| `tabs`, `webNavigation` | Badge counts, popup tab context, `GM_openInTab` and navigation commits. |
| `declarativeNetRequest` | Redirect `.user.js` navigations to the extension's install confirmation page. |
| `cookies` | Implement `GM_cookie` for scripts that request it. |
| `downloads` | Implement `GM_download` for scripts that request it. |
| `notifications`, `alarms`, `clipboardWrite` | GM APIs and background update checks. |
| `<all_urls>` | Userscripts may be configured to run on any site by the user. |
| `externally_connectable` | Allow a local agent to connect over MCP **only after** the user allowlists that extension ID in Settings → Agent. |

`scripting`, `activeTab` and `contextMenus` are intentionally not requested; userscripts run through `userScripts` plus the static bridge content script, `<all_urls>` covers tab access, and menu commands surface in the popup.

### Reviewer notes

- **Remote code**: the extension itself ships no remote code. Userscripts may
  declare `@require` / `@require-css` / `@resource` dependencies, which the
  extension downloads from URLs named by the script author (a standard
  userscript-manager behavior) and runs inside the user-installed script's
  scope. The user sees and confirms the dependency list on the install page.
- **`userScripts`**: required for the core function. Scripts are registered
  individually and can be disabled or removed at any time.
- **`<all_urls>`**: userscripts are user-configured and may target any site;
  the extension does not read pages by itself.
- **`externally_connectable`**: deny-by-default. `lib/agent/policy.ts` only
  accepts a sender whose extension ID the user explicitly added.

## Microsoft Edge Add-ons

### Name

Lumo Userscripts

### Short description (≤132 characters)

> A powerful, well-crafted userscript manager for your browser.

### Detailed description

Use the Chrome detailed description above, replacing the first line with:

> Lumo Userscripts is a fast, native userscript manager for Microsoft Edge
> (and Chrome).

### Category

Developer tools

### Permission justifications / reviewer notes

Use the same tables and notes as the Chrome Web Store section. Edge Add-ons
requires the same `userScripts`, `<all_urls>` and `externally_connectable`
explanations, plus the privacy policy URL.

## Submission checklist

- [ ] Privacy policy published at a public URL (GitHub Pages or repository file)
- [ ] Screenshots: popup, scripts list, editor, settings, logs (light and dark)
- [ ] Store icon (512×512) and promotional images, if required by the listing
- [ ] `npm run build` loads without errors in both Chrome and Edge
- [ ] `npm run zip` produces the package uploaded to both stores
- [ ] Verify in Edge: `edge://extensions` → **Allow User Scripts**, script
      registration, popup links, `GM_info`, and the agent allowlist
- [ ] Review notes pasted into the submission form (remote code, permissions)
