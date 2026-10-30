import type { RuntimeScriptPayload, ScriptWorld } from '@/types';

function joinRequires(requires: string[]): string {
  return requires.filter((item) => item.trim()).join('\n;\n');
}

/**
 * Generate the per-script launcher registered with `chrome.userScripts`.
 *
 * The user script body is compiled as part of the registered script (not with
 * `new Function`), so page CSP cannot block it. The launcher only contains a
 * queue shim; the shared runtime supplies GM APIs and lifecycle management.
 */
export function compileLauncher(payload: RuntimeScriptPayload, world: ScriptWorld): string {
  const engine = world === 'MAIN' ? '__LUMO_RUNNER__' : '__LUMO_HOST__';
  const queue = world === 'MAIN' ? '__LUMO_RUNNER_QUEUE__' : '__LUMO_HOST_QUEUE__';
  const data = JSON.stringify(payload);
  const requires = joinRequires(payload.requires);
  const css = (payload.requireCss ?? []).filter((item) => item.trim()).join('\n');
  const cssCode = css
    ? `try { var __lumoStyle = document.createElement('style'); __lumoStyle.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).appendChild(__lumoStyle); } catch (e) {}`
    : '';
  // `with (GM)` also exposes GM_info for @grant none. Other free variables keep
  // resolving through the outer page global scope. `@unwrap` intentionally
  // bypasses the wrapper and runs in the page scope with no GM APIs.
  const source = `${cssCode}\n${requires}\n${payload.code}`;
  const body = payload.unwrap
    ? source
    : `with (GM) {\n${source}\n}`;

  const runBody = payload.contextMenu
    ? `await GM['GM_registerMenuCommand'](${JSON.stringify(payload.name)}, async function () {\n${body}\n}, {});`
    : body;

  return `(function () {
  var p = ${data};
  p.run = async function (GM, GM_info, unsafeWindow) {
${runBody}
  };
  var g = globalThis;
  var q = g.${queue} || (g.${queue} = []);
  if (g.${engine}) g.${engine}.run(p);
  else q.push(p);
})();`;
}
