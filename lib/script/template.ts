export function newScriptTemplate(name = 'New script'): string {
  return `// ==UserScript==
// @name         ${name}
// @namespace    lumo
// @version      1.0.0
// @description
// @match        https://example.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Your code here.
})();
`;
}
