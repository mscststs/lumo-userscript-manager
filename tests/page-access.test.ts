import { describe, expect, it } from 'vitest';
import {
  getPageAccess,
  isFileUrl,
  isInjectableUrl,
} from '@/lib/page-access';

describe('page access', () => {
  it('marks privileged browser surfaces as non-injectable', () => {
    for (const [url, label] of [
      ['chrome://extensions/', 'chrome://'],
      ['chrome://settings', 'chrome://'],
      ['chrome-search://local-ntp/local-ntp.html', 'chrome-search://'],
      ['chrome-untrusted://terminal/', 'chrome-untrusted://'],
      ['chrome-extension://abcdefghijklmnop/popup.html', 'chrome-extension://'],
      ['devtools://devtools/bundled/inspector.html', 'devtools://'],
      ['about:blank', 'about:'],
      ['view-source:https://example.com/', 'view-source:'],
      ['moz-extension://abcdefghijklmnop/page.html', 'moz-extension://'],
      ['resource://gre/modules/commonjs/', 'resource://'],
    ] as const) {
      const access = getPageAccess(url);
      expect(access.injectable, url).toBe(false);
      expect(access.reason, url).toBe('restricted-scheme');
      expect(access.label, url).toBe(label);
    }
  });

  it('normalizes an upper-case scheme before classifying it', () => {
    const access = getPageAccess('CHROME://extensions/');
    expect(access.injectable).toBe(false);
    expect(access.label).toBe('chrome://');
  });

  it('marks the Chrome Web Store as protected', () => {
    for (const url of [
      'https://chromewebstore.google.com/detail/foo',
      'https://chrome.google.com/webstore/detail/foo',
    ]) {
      const access = getPageAccess(url);
      expect(access.injectable, url).toBe(false);
      expect(access.reason, url).toBe('protected-site');
    }

    // Only the /webstore subtree is protected on chrome.google.com.
    expect(isInjectableUrl('https://chrome.google.com/other')).toBe(true);
  });

  it('allows ordinary documents', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost:8080/app',
      'https://sub.example.org/path?q=1#hash',
      'file:///home/user/page.html',
    ]) {
      expect(getPageAccess(url).injectable, url).toBe(true);
    }
  });

  it('reports a missing URL as inaccessible', () => {
    expect(getPageAccess(undefined)).toEqual({ injectable: false, reason: 'missing-url' });
    expect(getPageAccess('   ')).toEqual({ injectable: false, reason: 'missing-url' });
    expect(isInjectableUrl('')).toBe(false);
  });

  it('keeps unparseable URLs on the rule-only path', () => {
    expect(getPageAccess('not a url')).toEqual({ injectable: true });
  });

  it('detects file URLs separately for the permission check', () => {
    expect(isFileUrl('file:///tmp/page.html')).toBe(true);
    expect(isFileUrl('https://example.com/')).toBe(false);
    expect(isFileUrl(undefined)).toBe(false);
  });
});
