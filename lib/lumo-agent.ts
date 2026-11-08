/**
 * Install locations for Lumo — the browser agent that consumes this
 * extension's MCP endpoint.
 *
 * The two store listings are the same codebase published twice, so either one
 * is enough; the repository is the only route that carries unreleased builds.
 * Kept here rather than inline in the settings page so a listing change is a
 * one-line edit and the About/onboarding surfaces can never disagree.
 */
export const LUMO_CHROME_STORE_URL =
  'https://chromewebstore.google.com/detail/lumo/cgfnadidpooocnkalljpdmelmaponefa';

export const LUMO_EDGE_ADDONS_URL =
  'https://microsoftedge.microsoft.com/addons/detail/lumo/ngbkkjamclloepccimlbfffkcablpahh';

export const LUMO_REPOSITORY_URL = 'https://github.com/mscststs/lumo';
