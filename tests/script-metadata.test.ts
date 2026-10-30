import { describe, expect, it } from 'vitest';
import {
  mergeMetadata,
  parseMetadata,
  getLocalizedMeta,
  hasMeta,
  resolveMetadataUrls,
} from '@/lib/script/metadata';
import { compileUrlRules, toRegistrationPatterns, urlMatches } from '@/lib/script/url-rules';
import { compileLauncher } from '@/lib/script/compile';
import type { RuntimeScriptPayload } from '@/types';

const SCRIPT = `// ==UserScript==
// @name        Example
// @name:zh-CN  示例
// @namespace   demo
// @version     1.2.3
// @match       https://example.com/*
// @include     https://*.example.org/*
// @exclude     https://private.example.com/*
// @grant       GM_setValue
// @grant       GM_getValue
// @connect     api.example.com
// @require     https://cdn.example.com/lib.js
// @resource    logo https://example.com/logo.png
// ==/UserScript==

console.log('hello');
`;

describe('metadata parser', () => {
  it('parses tags, locales and resource declarations', () => {
    const parsed = parseMetadata(SCRIPT);
    expect(parsed.errors).toEqual([]);
    expect(parsed.metadata.name).toEqual(['Example']);
    expect(parsed.metadata['name:zh-cn']).toEqual(['示例']);
    expect(parsed.metadata.grant).toEqual(['GM_setValue', 'GM_getValue']);
    expect(parsed.metadata.require).toEqual(['https://cdn.example.com/lib.js']);
    expect(parsed.metadata.resource).toEqual(['logo https://example.com/logo.png']);
    expect(getLocalizedMeta(parsed.metadata, 'name', 'zh-CN')).toBe('示例');
  });

  it('rejects a missing metablock and invalid match patterns', () => {
    expect(parseMetadata('console.log(1)').errors.length).toBe(1);
    const parsed = parseMetadata(
      '// ==UserScript==\n// @name X\n// @match not-a-pattern\n// ==/UserScript==',
    );
    expect(parsed.errors.some((error) => error.includes('Invalid @match'))).toBe(true);
  });

  it('normalizes @grant none', () => {
    const parsed = parseMetadata(
      '// ==UserScript==\n// @name X\n// @grant none\n// @grant GM_setValue\n// ==/UserScript==',
    );
    expect(parsed.metadata.grant).toEqual(['none']);
    expect(parsed.warnings.length).toBe(1);
  });

  it('merges overrides without mutating the base', () => {
    const parsed = parseMetadata(SCRIPT);
    const merged = mergeMetadata(parsed.metadata, { match: ['https://other.test/*'] });
    expect(parsed.metadata.match).toEqual(['https://example.com/*']);
    expect(merged.match).toEqual(['https://other.test/*']);
  });

  it('treats an empty override list as removed', () => {
    // The editor turns a declared flag off by writing `[]`; presence checks must
    // follow the value list, not the key.
    const parsed = parseMetadata(
      '// ==UserScript==\n// @name X\n// @noframes\n// ==/UserScript==',
    );
    expect(hasMeta(parsed.metadata, 'noframes')).toBe(true);
    expect(hasMeta(mergeMetadata(parsed.metadata, { noframes: [] }), 'noframes')).toBe(false);
    expect(hasMeta(mergeMetadata(parsed.metadata, { noframes: [''] }), 'noframes')).toBe(true);
    expect(hasMeta(parsed.metadata, 'unwrap')).toBe(false);
  });

  it('resolves relative metadata URLs against the install URL', () => {
    const metadata = resolveMetadataUrls(
      {
        require: ['./lib.js'],
        'require-css': ['/assets/app.css'],
        resource: ['logo ./logo.png'],
        icon: ['./icon.png'],
        updateurl: ['./meta.user.js'],
      },
      'https://example.com/scripts/demo.user.js',
    );
    expect(metadata.require).toEqual(['https://example.com/scripts/lib.js']);
    expect(metadata['require-css']).toEqual(['https://example.com/assets/app.css']);
    expect(metadata.resource).toEqual(['logo https://example.com/scripts/logo.png']);
    expect(metadata.icon).toEqual(['https://example.com/scripts/icon.png']);
    expect(metadata.updateurl).toEqual(['https://example.com/scripts/meta.user.js']);
  });
});

describe('URL rules', () => {
  const parsed = parseMetadata(SCRIPT);
  const rules = compileUrlRules(parsed.metadata);

  it('matches match and include rules, and honors excludes', () => {
    expect(urlMatches('https://example.com/page', rules)).toBe(true);
    expect(urlMatches('https://sub.example.org/page', rules)).toBe(true);
    expect(urlMatches('https://private.example.com/page', rules)).toBe(false);
    expect(urlMatches('https://unrelated.test/page', rules)).toBe(false);
  });

  it('supports glob and regex includes', () => {
    const glob = compileUrlRules({ include: ['https://*.test/path/*'], exclude: [] });
    expect(urlMatches('https://a.test/path/x', glob)).toBe(true);
    expect(urlMatches('https://a.test/other', glob)).toBe(false);

    const regex = compileUrlRules({ include: ['/^https:\\/\\/api\\.test\\//i'], exclude: [] });
    expect(urlMatches('https://api.test/v1', regex)).toBe(true);
    expect(urlMatches('https://www.test/v1', regex)).toBe(false);
  });

  it('defaults to all pages when no positive rule exists', () => {
    const all = compileUrlRules({});
    expect(urlMatches('https://anything.test/', all)).toBe(true);
    const patterns = toRegistrationPatterns(all);
    expect(patterns.matches).toContain('*://*/*');
    expect(patterns.matches).toContain('file:///*');
  });

  it('never matches pages the browser refuses to inject into', () => {
    const all = compileUrlRules({});
    expect(urlMatches('chrome://extensions/', all)).toBe(false);
    expect(urlMatches('chrome-extension://abc/popup.html', all)).toBe(false);
    expect(urlMatches('https://chromewebstore.google.com/detail/x', all)).toBe(false);

    // Even an explicit catch-all include must not resurrect them.
    const everything = compileUrlRules({ include: ['*'] });
    expect(urlMatches('chrome://newtab/', everything)).toBe(false);
  });

  it('keeps match patterns with explicit ports as runtime-checked globs', () => {
    const portRules = compileUrlRules({ match: ['http://localhost:8080/*'] });
    const patterns = toRegistrationPatterns(portRules);
    expect(patterns.matches).toContain('*://*/*');
    expect(patterns.includeGlobs).toContain('http://localhost:8080/*');
    expect(urlMatches('http://localhost:8080/app', portRules)).toBe(true);
    expect(urlMatches('http://localhost:9090/app', portRules)).toBe(false);
  });

  it('widens registration for regex-only rules', () => {
    const patterns = toRegistrationPatterns(
      compileUrlRules({ include: ['/^https:\\/\\/api\\.test\\//'] }),
    );
    expect(patterns.matches).toContain('*://*/*');
    expect(patterns.needsRuntimeCheck).toBe(true);
  });
});

describe('launcher compiler', () => {
  const parsed = parseMetadata(SCRIPT);
  const payload: RuntimeScriptPayload = {
    uuid: 'u1',
    runtimeToken: 'MAIN.test',
    name: 'Example',
    namespace: 'demo',
    version: '1.2.3',
    metaStr: parsed.metaStr,
    meta: parsed.metadata,
    handlerVersion: '0.1.0',
    grant: ['GM_setValue'],
    connect: [],
    rules: compileUrlRules(parsed.metadata),
    code: "console.log('body');",
    requires: ["console.log('require');"],
    requireCss: ['body { color: red; }'],
    resourceNames: ['logo'],
    runAt: 'document-idle',
    injectInto: 'page',
    noFrames: false,
    unwrap: false,
    contextMenu: false,
  };

  it('embeds the body, @require source and queue shim', () => {
    const code = compileLauncher(payload, 'MAIN');
    expect(code).toContain("console.log('body');");
    expect(code).toContain("console.log('require');");
    expect(code).toContain('body { color: red; }');
    expect(code).toContain('__LUMO_RUNNER_QUEUE__');
    expect(code).toContain('__LUMO_RUNNER__');
    expect(code).toContain('with (GM)');
  });

  it('uses the host queue for content-world scripts', () => {
    const code = compileLauncher(payload, 'USER_SCRIPT');
    expect(code).toContain('__LUMO_HOST_QUEUE__');
    expect(code).toContain('__LUMO_HOST__');
  });

  it('bypasses the GM wrapper for @unwrap scripts', () => {
    const code = compileLauncher({ ...payload, unwrap: true }, 'MAIN');
    expect(code).not.toContain('with (GM)');
  });

  it('produces syntactically valid launchers for every world', () => {
    expect(() => new Function(compileLauncher(payload, 'MAIN'))).not.toThrow();
    expect(() => new Function(compileLauncher(payload, 'USER_SCRIPT'))).not.toThrow();
    expect(() =>
      new Function(
        compileLauncher({ ...payload, contextMenu: true, runAt: 'context-menu' }, 'MAIN'),
      ),
    ).not.toThrow();
  });

  it('passes the page-realm unsafeWindow into the script body', async () => {
    const runtime = { run: null as null | (() => void) };
    const unsafeWindow = {} as any;
    (globalThis as any).__LUMO_RUNNER__ = {
      run: (next: RuntimeScriptPayload) => {
        runtime.run = () => next.run!(Object.create(null), {}, unsafeWindow);
      },
    };
    (globalThis as any).__LUMO_RUNNER_QUEUE__ = [];
    const launcher = compileLauncher(
      { ...payload, code: "unsafeWindow.marker = 'page';" },
      'MAIN',
    );
    new Function(launcher)();
    runtime.run?.();
    await Promise.resolve();
    expect(unsafeWindow.marker).toBe('page');
    delete (globalThis as any).__LUMO_RUNNER__;
    delete (globalThis as any).__LUMO_RUNNER_QUEUE__;
  });
});
