# Privacy Policy

**Lumo Userscripts — Userscript Manager**

## Overview

Lumo Userscripts is an open-source browser extension for managing and running
userscripts in Chromium-based browsers, including Google Chrome and Microsoft
Edge. This privacy policy describes how it handles (or does not handle) user
data.

## Data Collection

**Lumo Userscripts does not collect, store, transmit, or share any personal data or user information.**

Specifically, it does NOT:

- Collect browsing history, bookmarks, or download records
- Track user behavior or analytics
- Store personally identifiable information (PII)
- Transmit any data to servers owned or operated by the project maintainers
- Use cookies or any tracking technologies
- Access user data for advertising or marketing purposes

## User Scripts

All scripts, their source code, metadata and execution logs are stored locally on
the user's device. Scripts run only on pages matched by rules the user
configures. No script content is uploaded anywhere by the extension itself.

## Local Storage

Lumo Userscripts may store the following data **locally on the user's device**
using the browser's built-in extension storage APIs (extension storage and
IndexedDB):

- User preferences and settings (e.g., theme, language, UI scale)
- Installed userscripts, their metadata and resources
- Script execution configuration and local logs

This data is stored entirely on the user's local device, is never transmitted to
any server operated by the project maintainers, and can be deleted at any time
through the extension's settings or by uninstalling the extension.

## Permissions

Lumo Userscripts requests the following browser permissions solely to provide
its core functionality — installing, editing and running userscripts on pages
the user chooses:

| Permission | Purpose |
| --- | --- |
| `storage`, `unlimitedStorage` | Store settings, bounded metadata and the IndexedDB data that holds script bodies, revisions and logs |
| `tabs`, `webNavigation` | Badge counts, popup tab context, `GM_openInTab` and navigation commits |
| `userScripts` | Register and run userscripts |
| `declarativeNetRequest` | Redirect `.user.js` navigations to the install page |
| `cookies` | Implement `GM_cookie` for userscripts that request it |
| `downloads` | Implement `GM_download` for userscripts that request it |
| `notifications`, `alarms`, `clipboardWrite` | GM APIs and background update jobs |
| `<all_urls>` | Run userscripts only on the pages the user configures |

`scripting`, `activeTab` and `contextMenus` are intentionally not requested:
userscripts are injected through `userScripts` plus the static bridge content
script, `<all_urls>` already covers tab access, and `GM_registerMenuCommand` is
surfaced in the popup rather than the browser context menu.

`externally_connectable` allows other extensions to open an MCP (Model Context
Protocol) session with Lumo Userscripts **only after the user explicitly allows
that extension ID** in Settings → Agent. The endpoint is deny-by-default and
never exposes data before that approval.

These permissions are never used to collect or transmit user data.

## Third-Party Content

A userscript may itself contact third-party services, and may declare remote
dependencies such as `@require`, `@require-css` or `@resource`. When the user
installs or updates such a script, Lumo Userscripts downloads those files from
the URLs named by the script author. These requests carry no user identifiers
from the extension and are subject to the destination server's own privacy
practices. Such behavior is defined by the script's author and is outside the
extension's control. Users should review scripts before installing them.

## Children's Privacy

Lumo Userscripts does not knowingly collect any information from children under
13 years of age.

## Changes to This Policy

If this privacy policy is updated, the changes will be reflected in this
document. As an open-source project, all changes are publicly visible in the
project's Git history.

## Contact

If you have any questions or concerns regarding this privacy policy, please open
an issue on the project's GitHub repository:
<https://github.com/mscststs/lumo-userscript-manager/issues>

---

*This privacy policy applies to the Lumo Userscripts browser extension
distributed via the Chrome Web Store, Microsoft Edge Add-ons, and/or built from
source.*
