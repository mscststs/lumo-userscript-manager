#!/usr/bin/env node
/**
 * Locale contract checker.
 *
 * Run with `npm run i18n:check`. It fails on:
 *  - a bundle missing a key that exists in `en.json` (or carrying an extra one),
 *  - an empty translation,
 *  - a `{{placeholder}}` that does not match the English source exactly,
 *  - a missing CLDR plural category for a `_one`-style plural key.
 *
 * It is intentionally dependency-free and works on the JSON files directly, so
 * it can run in CI without booting i18next or a browser.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const localesDir = join(root, 'i18n/locales');

/** @param {unknown} value @param {string} prefix @param {Map<string,string>} out */
function flatten(value, prefix, out) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (typeof value === 'string') {
    out.set(prefix, value);
  }
}

const en = new Map();
flatten(JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8')), '', en);

const placeholders = (text) =>
  [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]).sort();

/** Strip i18next's plural suffix to find the base key. */
const pluralSuffix = /_(zero|one|two|few|many|other)$/;

const failures = [];

/** Long English strings that are intentionally identical in every locale. */
const ALLOW_IDENTICAL = new Set([
  'scripts.urlPlaceholder',
  'settings.agent.intro.stores.github',
  'settings.agent.intro.stores.chrome',
  'settings.agent.intro.stores.edge',
  'diagnostics.metadata.antifeature',
]);

// Registry <-> files: every registered tag needs a bundle (ready or draft), and
// no stale bundle may linger after a language is removed.
const registrySource = readFileSync(join(root, 'i18n/locales.ts'), 'utf8');
const registry = [...registrySource.matchAll(
  /tag:\s*'([^']+)',[\s\S]*?status:\s*'(ready|draft)'/g
)].map((m) => ({ tag: m[1], status: m[2] }));
const registeredTags = new Set(registry.map((entry) => entry.tag));
const files = readdirSync(localesDir).filter((file) => file.endsWith('.json'));
const fileTags = files.map((file) => file.replace(/\.json$/, ''));

for (const tag of registeredTags) {
  if (!fileTags.includes(tag)) failures.push(`registry: missing bundle for "${tag}"`);
}
for (const tag of fileTags) {
  if (!registeredTags.has(tag)) failures.push(`registry: stale bundle "${tag}"`);
}


for (const file of files) {
  const tag = file.replace(/\.json$/, '');
  const bundle = new Map();
  flatten(JSON.parse(readFileSync(join(localesDir, file), 'utf8')), '', bundle);

  for (const [key, english] of en) {
    const translated = bundle.get(key);
    if (translated === undefined) {
      failures.push(`${tag}: missing key "${key}"`);
      continue;
    }
    if (translated.trim() === '') {
      failures.push(`${tag}: empty value for "${key}"`);
    }
    // Invisible formatting characters have caused real layout bugs. ZWNJ/ZWJ
    // are legitimate in Persian/Indic scripts, but ZWSP/BOM are always noise.
    if (/[\u200B\uFEFF]/.test(translated)) {
      failures.push(`${tag}: zero-width space/BOM in "${key}"`);
    }
    // The bootstrap helper used numeric markers; a surviving marker means the
    // value is still a draft, not a finished translation.
    if (/__\d+__/.test(translated)) {
      failures.push(`${tag}: leftover translation marker in "${key}"`);
    }
    // A long sentence identical to English is almost always a leftover
    // placeholder, not a legitimate loanword. Short identical words (Auto, ID,
    // Info) are intentionally allowed.
    if (
      tag !== 'en' && !tag.startsWith('en-') &&
      translated === english &&
      english.length > 24 &&
      !ALLOW_IDENTICAL.has(key)
    ) {
      failures.push(`${tag}: untranslated value for "${key}"`);
    }
    const expected = placeholders(english);
    const actual = placeholders(translated);
    if (expected.join(',') !== actual.join(',')) {
      failures.push(
        `${tag}: placeholder mismatch in "${key}" — expected {${expected.join(', ')}}, got {${actual.join(', ')}}`
      );
    }
  }

  for (const key of bundle.keys()) {
    if (en.has(key)) continue;
    // Extra plural categories (`_many`, `_few`, …) are expected: English only
    // defines `_one`/`_other`, while e.g. French also needs `_many`.
    const base = key.replace(pluralSuffix, '');
    if (pluralSuffix.test(key) && en.has(`${base}_other`)) continue;
    failures.push(`${tag}: unknown key "${key}"`);
  }

  // Plural categories: i18next resolves `key_<category>` from Intl.PluralRules.
  const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
  for (const key of en.keys()) {
    if (!pluralSuffix.test(key)) continue;
    const base = key.replace(pluralSuffix, '');
    if (!en.has(`${base}_other`)) continue;
    for (const category of categories) {
      if (!bundle.has(`${base}_${category}`)) {
        failures.push(`${tag}: plural category "${base}_${category}" missing`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`i18n check failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`i18n check passed: ${files.length} locales, ${en.size} keys each.`);
