#!/usr/bin/env node
/**
 * Hardcoded visible-string scanner.
 *
 * The i18n check script can only compare keys that exist. It cannot see a label
 * someone typed directly into JSX. This AST pass looks at the places the user
 * actually reads — JSX text, visible attributes, and static `<title>` tags —
 * and fails when a literal is not covered by the allowlist.
 *
 * Run with `npm run i18n:scan`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const roots = ['components', 'entrypoints'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const VISIBLE_ATTRS = new Set([
  'title',
  'aria-label',
  'aria-description',
  'placeholder',
  'alt',
  'label',
  'description',
  'tooltip',
]);

/**
 * Strings that are not product copy: brand wordmark, code syntax, URL examples,
 * units and structural version glyphs.
 */
const ALLOW = [
  /^Lumo Userscripts$/,
  /^→? ?v$/,
  /^px$/,
  /^github\.com\/mscststs\/lumo-userscript-manager$/,
  /^"text" · 42 · true · \{"a":1\}$/,
  /^GM_setValue key$/,
];

const findings = [];

for (const dir of roots) {
  for (const file of walk(join(root, dir))) {
    const source = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const report = (node, kind, text) => {
      const value = text.trim();
      if (!value || !/[A-Za-z]/.test(value)) return;
      if (ALLOW.some((pattern) => pattern.test(value))) return;
      // CSS, URLs and code snippets are not product copy.
      if (/^(?:[a-z0-9:_\-./[\]#%(),\s]+|https?:\/\/\S+)$/i.test(value)) return;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      findings.push(`${relative(root, file)}:${line} [${kind}] ${value.slice(0, 100)}`);
    };

    const visit = (node) => {
      if (ts.isJsxText(node)) report(node, 'text', node.getText(sf));
      if (ts.isJsxAttribute(node)) {
        const name = node.name.getText(sf);
        if (
          VISIBLE_ATTRS.has(name) &&
          node.initializer &&
          ts.isStringLiteral(node.initializer)
        ) {
          report(node, name, node.initializer.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

// Static page titles: the dynamic title hook replaces them after mount, but a
// hardcoded page-specific title would still leak during the first frame.
for (const file of ['entrypoints/popup/index.html', 'entrypoints/options/index.html', 'entrypoints/install/index.html']) {
  const html = readFileSync(join(root, file), 'utf8');
  for (const match of html.matchAll(/<title>([^<]*)<\/title>/g)) {
    const text = match[1].trim();
    if (text && text !== 'Lumo Userscripts') findings.push(`${file} [title] ${text}`);
  }
}

if (findings.length > 0) {
  console.error(`i18n:scan found ${findings.length} hardcoded visible string(s):`);
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}

console.log('i18n:scan passed: no hardcoded visible strings.');
