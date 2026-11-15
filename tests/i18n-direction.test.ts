// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { localeDirection } from '@/i18n/locales';
import { applyLanguage } from '@/i18n';

const PHYSICAL = /\b(?:ml|mr|pl|pr|left|right|text-left|text-right|rounded-l|rounded-r|border-l|border-r)-/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts|css)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('text direction', () => {
  it('marks every RTL Chrome locale', () => {
    for (const tag of ['ar', 'fa', 'he']) expect(localeDirection(tag)).toBe('rtl');
  });

  it('applies the resolved language to <html lang/dir>', async () => {
    await applyLanguage('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');

    await applyLanguage('zh-TW');
    expect(document.documentElement.lang).toBe('zh-TW');
    expect(document.documentElement.dir).toBe('ltr');

    // A registered but untranslated locale must not leave a foreign `<html>`
    // tag over an English UI.
    await applyLanguage('xx-YY');
    expect(document.documentElement.lang.startsWith('en')).toBe(true);
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('has no physical direction utilities in UI sources', () => {
    const offenders: string[] = [];
    for (const file of [...walk('components'), ...walk('entrypoints'), ...walk('assets')]) {
      const source = readFileSync(file, 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        // Code previews/terminal output intentionally stay LTR; `border-radius`
        // is not a direction utility even though it contains "border-r".
        if (/border-radius/.test(line)) continue;
        if (PHYSICAL.test(line)) offenders.push(`${file}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
