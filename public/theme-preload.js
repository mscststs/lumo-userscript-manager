/**
 * Synchronous first-paint appearance painter.
 *
 * Runs from `<head>` before the stylesheet and before any module executes, so
 * the very first frame is already the correct palette instead of flashing white
 * and repainting once React mounts.
 *
 * Why it cannot read the real setting: the source of truth is
 * `chrome.storage.local`, whose API is asynchronous and therefore unusable here
 * — anything awaited happens after the browser has painted. So `lib/theme.ts`
 * mirrors the resolved appearance into `localStorage` (same extension origin,
 * so shared by popup / options / install) purely as a synchronously readable
 * cache. This file only reads that mirror; `chrome.storage.local` stays
 * authoritative and `ThemeInit` corrects the DOM if the two disagree.
 *
 * The mirror carries the palette *name*, its `dark` flag, and its exact
 * canvas colour. Shipping the colour itself is what keeps this script free of
 * a duplicated palette table: there is nothing here to drift from
 * `assets/globals.css`, only two defaults used on the very first launch.
 *
 * Why it paints an inline background rather than relying on CSS: in dev builds
 * there is no stylesheet at first paint at all. `globals.css` is imported from
 * `main.tsx`, so Vite injects it as a `<style>` tag at runtime — setting
 * `data-theme` alone would select a token block that does not exist yet, leaving
 * the page white until the module graph loads.
 *
 * Kept as a plain classic script in `public/` on purpose:
 * - MV3's CSP (`script-src 'self'`) forbids inline scripts.
 * - `type="module"` is implicitly deferred, which would put it after first paint
 *   and defeat the entire point.
 * - Being copied verbatim means it cannot import the registry; the mirror
 *   contract in `lib/theme.ts` is the only interface between the two, and
 *   `tests/theme.test.ts` pins it.
 */
(function () {
  'use strict';

  // Defaults for the first launch, before any `applyTheme` has run. These are
  // the `light` and `dark` palettes' `--color-background` values and are
  // asserted against `lib/theme-registry.ts` by tests.
  var FALLBACK = {
    light: { dark: false, background: 'oklch(0.985 0.002 95)' },
    dark: { dark: true, background: 'oklch(0.168 0.004 270)' },
  };

  var THEME_KEY = 'lumo-us:resolved-theme';
  var ACCENT_KEY = 'lumo-us:accent';
  var ACCENTS = ['azure', 'violet', 'emerald', 'amber', 'rose'];

  var root = document.documentElement;

  function read(key) {
    // Guarded: `localStorage` throws outright when storage is partitioned or
    // disabled by policy. An uncaught throw would abort the script and leave the
    // page with no theme at all.
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  var prefersDark = false;
  try {
    prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {
    prefersDark = false;
  }

  var fallback = prefersDark ? FALLBACK.dark : FALLBACK.light;
  var resolved = fallback;
  var name = prefersDark ? 'dark' : 'light';

  var mirrored = read(THEME_KEY);
  if (mirrored) {
    try {
      var parsed = JSON.parse(mirrored);
      // Shape-check rather than trust: a value written by an older build (or a
      // half-migrated storage) must not reach `style.backgroundColor`.
      if (
        parsed &&
        typeof parsed.background === 'string' &&
        parsed.background.length > 0 &&
        parsed.background.length < 160 &&
        typeof parsed.dark === 'boolean' &&
        typeof parsed.name === 'string'
      ) {
        resolved = { dark: parsed.dark, background: parsed.background };
        name = parsed.name;
      }
    } catch (e) {
      // Not JSON — an older build wrote a bare palette name. Honour the
      // light/dark *choice* it encoded (so an upgrade does not flash the wrong
      // scheme) but use the default background for that scheme.
      if (mirrored === 'light' || mirrored === 'dark' || mirrored === 'midnight') {
        name = mirrored;
        resolved = mirrored === 'light' ? FALLBACK.light : FALLBACK.dark;
      } else {
        resolved = fallback;
      }
    }
  }

  // Both channels `applyTheme` uses: `.dark` drives Tailwind's `dark:` variant
  // and the Shiki overrides, `data-theme` selects the token block.
  if (resolved.dark) root.classList.add('dark');
  root.setAttribute('data-theme', name);

  var accent = read(ACCENT_KEY);
  if (accent && ACCENTS.indexOf(accent) !== -1) {
    root.setAttribute('data-accent', accent);
  }

  // The part that survives a missing stylesheet. `color-scheme` additionally
  // themes the canvas, native scrollbars and form controls, which no token can
  // reach. Marked so `applyTheme` knows to hand control back to the stylesheet.
  root.style.backgroundColor = resolved.background;
  root.style.colorScheme = resolved.dark ? 'dark' : 'light';
  root.setAttribute('data-theme-preload', '');

  // ─── Font Size ────────────────────────────────────────────────────────────
  // Same mirror pattern: `lib/font-size.ts` writes to localStorage, read here
  // synchronously so the first frame is already at the correct scale.
  var FONT_SIZE_KEY = 'lumo-us:font-size';
  var DEFAULT_SIZE = 16;
  var VALID_SIZES = [12, 13, 14, 15, 16, 17, 18];
  var rawSize = read(FONT_SIZE_KEY);
  var fontSize = rawSize !== null ? Number(rawSize) : DEFAULT_SIZE;
  if (VALID_SIZES.indexOf(fontSize) === -1) fontSize = DEFAULT_SIZE;
  root.style.fontSize = fontSize + 'px';
})();
