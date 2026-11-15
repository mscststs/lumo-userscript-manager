#!/usr/bin/env node
/** Mark a locale as reviewed: flip its registry status and update the ledger. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const [tag, corrections = '0', note = 'line-by-line review'] = process.argv.slice(2);
if (!tag) {
  console.error('Usage: node scripts/i18n/mark-reviewed.mjs <tag> <corrections> [note]');
  process.exit(1);
}

const registryPath = join(root, 'i18n/locales.ts');
let registry = readFileSync(registryPath, 'utf8');
const linePattern = new RegExp(`(tag: '${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[^\\n]*?)status: 'draft'`);
if (!linePattern.test(registry)) {
  // Multi-line descriptors (es-419, pt-BR, en-*) need the block form.
  const blockPattern = new RegExp(`(tag: '${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[\\s\\S]*?)status: 'draft'`);
  if (!blockPattern.test(registry)) {
    console.error(`No draft status found for ${tag}`);
    process.exit(1);
  }
  registry = registry.replace(blockPattern, "$1status: 'ready'");
} else {
  registry = registry.replace(linePattern, "$1status: 'ready'");
}
writeFileSync(registryPath, registry);

const ledgerPath = join(root, 'docs/i18n-review.md');
let ledger = readFileSync(ledgerPath, 'utf8');
const rowPattern = new RegExp(`\\| \`${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\` \\| draft \\| 0 \\| 0 \\| [^|]+ \\|`);
const row = `| \`${tag}\` | ready | 434 | ${corrections} | ${note} |`;
if (rowPattern.test(ledger)) ledger = ledger.replace(rowPattern, row);
else {
  const fallback = new RegExp(`\\| \`${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\` \\|[^\\n]*`);
  ledger = ledger.replace(fallback, row);
}
writeFileSync(ledgerPath, ledger);
console.log(`${tag}: marked ready (${corrections} corrections)`);
