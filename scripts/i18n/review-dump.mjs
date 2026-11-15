#!/usr/bin/env node
/**
 * Development helper: print an English/target aligned review table.
 *
 * This does not translate anything. It exists so a human can read every key in
 * a locale file next to the English source and spot semantic, plural, tone and
 * placeholder problems before the locale is marked `ready`.
 *
 * Usage:
 *   node scripts/i18n/review-dump.mjs it
 *   node scripts/i18n/review-dump.mjs it --ns settings
 *   node scripts/i18n/review-dump.mjs it --tsv
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const tag = args.find((arg) => !arg.startsWith('--'));
const nsIndex = args.indexOf('--ns');
const namespace = nsIndex !== -1 ? args[nsIndex + 1] : undefined;
const tsv = args.includes('--tsv');

if (!tag) {
  console.error('Usage: node scripts/i18n/review-dump.mjs <tag> [--ns <namespace>] [--tsv]');
  process.exit(1);
}

const en = JSON.parse(readFileSync(join(root, 'i18n/locales/en.json'), 'utf8'));
const target = JSON.parse(readFileSync(join(root, 'i18n/locales', `${tag}.json`), 'utf8'));

function flatten(value, prefix = '', out = []) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.push([prefix, String(value)]);
  }
  return out;
}

function getPath(value, path) {
  return path.split('.').reduce((node, part) => node?.[part], value);
}

const placeholders = (text) =>
  [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]).sort().join(',');

const pluralSuffix = /_(zero|one|two|few|many|other)$/;
const rows = [];
for (const [key, english] of flatten(en)) {
  if (namespace && !key.startsWith(`${namespace}.`)) continue;
  const translated = getPath(target, key);
  const value = typeof translated === 'string' ? translated : '';
  const flags = [];
  if (!value.trim()) flags.push('EMPTY');
  if (placeholders(english) !== placeholders(value)) flags.push('PLACEHOLDER');
  if (tag !== 'en' && !tag.startsWith('en-') && value === english && english.length > 24) {
    flags.push('IDENTICAL');
  }
  if (value && english.length >= 8) {
    const ratio = value.length / english.length;
    if (ratio > 2.2) flags.push('LONG');
    if (ratio < 0.45) flags.push('SHORT');
  }
  const plural = key.match(pluralSuffix);
  if (plural && plural[1] !== 'other') {
    const other = getPath(target, key.replace(pluralSuffix, '_other'));
    if (other === value) flags.push('PLURAL=OTHER');
  }
  rows.push({ key, english, value, flags });
}

if (tsv) {
  for (const row of rows) {
    const clean = (text) => text.replace(/\t/g, '\\t').replace(/\n/g, '\\n');
    console.log(`${row.key}\t${clean(row.english)}\t${clean(row.value)}\t${row.flags.join(',')}`);
  }
} else {
  let current = '';
  for (const row of rows) {
    const ns = row.key.split('.')[0];
    if (ns !== current) {
      current = ns;
      console.log(`\n## ${ns}`);
    }
    console.log(`\n${row.key}${row.flags.length ? ` [${row.flags.join(', ')}]` : ''}`);
    console.log(`  EN: ${row.english.replace(/\n/g, '\\n')}`);
    console.log(`  ${tag}: ${row.value.replace(/\n/g, '\\n')}`);
  }
}

const count = (flag) => rows.filter((row) => row.flags.includes(flag)).length;
console.error(
  `\n${tag}: ${rows.length} keys · PLACEHOLDER ${count('PLACEHOLDER')} · EMPTY ${count('EMPTY')} · ` +
    `IDENTICAL ${count('IDENTICAL')} · PLURAL=OTHER ${count('PLURAL=OTHER')} · ` +
    `LONG ${count('LONG')} · SHORT ${count('SHORT')}`
);
