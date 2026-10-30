import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACCENTS,
  ACCENT_OPTIONS,
  DARK_THEME_OPTIONS,
  DEFAULT_ACCENT,
  DEFAULT_DARK_THEME,
  DEFAULT_THEME_MODE,
  SYSTEM_DARK_THEME,
  THEMES,
  THEME_MODE_OPTIONS,
  THEME_PALETTES,
  normalizeAccent,
  normalizeDarkTheme,
  normalizeThemeMode,
} from '@/lib/theme-registry';
import { themePreloadPlugin } from '@/lib/build/theme-preload-plugin';

const CSS = readFileSync(resolve(__dirname, '../assets/globals.css'), 'utf8');
const PRELOAD = readFileSync(resolve(__dirname, '../public/theme-preload.js'), 'utf8');

/**
 * Slice out a token block. Selectors are matched literally so a renamed selector
 * fails loudly instead of silently reading the wrong palette.
 */
function block(selector: string): string {
  const start = CSS.indexOf(selector);
  expect(start, `no block for ${selector}`).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf('}', start));
}

const LIGHT = block('@theme {');
const DARK = block('.dark {');
const MIDNIGHT = block('[data-theme="midnight"] {');

/** Every `--color-*` token declared by the base (light) palette. */
function baseTokens(): string[] {
  return [...LIGHT.matchAll(/(--color-[\w-]+):/g)].map((match) => match[1]!);
}

describe('theme registry', () => {
  it('registers exactly the palettes the stylesheet defines', () => {
    expect(THEME_PALETTES).toEqual(['light', 'dark', 'midnight']);
  });

  it('offers light / dark / system, with `system` last', () => {
    const values = THEME_MODE_OPTIONS.map((option) => option.value);
    expect(values).toEqual(['light', 'dark', 'system']);
  });

  it('offers both dark palettes and defaults to one that exists', () => {
    const values = DARK_THEME_OPTIONS.map((option) => option.value);
    expect(values).toEqual(['dark', 'midnight']);
    expect(values).toContain(DEFAULT_DARK_THEME);
  });

  it('resolves `system` to a palette that is actually registered', () => {
    expect(SYSTEM_DARK_THEME in THEMES).toBe(true);
  });

  it('describes every palette with a label, a description and a swatch', () => {
    for (const [name, definition] of Object.entries(THEMES)) {
      expect(definition.labelKey, `${name} label`).toBeTruthy();
      expect(definition.descriptionKey, `${name} description`).toBeTruthy();
      expect(definition.swatch.background, `${name} swatch`).toBeTruthy();
      expect(['light', 'dark']).toContain(definition.scheme);
    }
  });

  describe('normalizeThemeMode', () => {
    it('passes through every preference', () => {
      for (const mode of ['light', 'dark', 'system'] as const) {
        expect(normalizeThemeMode(mode)).toBe(mode);
      }
    });

    it('migrates the legacy `midnight` preference to dark', () => {
      // Before the split, `theme` carried the palette. `midnight` meant
      // "dark, in Midnight" and must not silently become `system`.
      expect(normalizeThemeMode('midnight')).toBe('dark');
    });

    it.each([
      ['a theme from a newer build', 'solarized'],
      ['a missing field', undefined],
      ['a non-string', 42],
    ])('falls back to the default for %s', (_label, input) => {
      expect(normalizeThemeMode(input)).toBe(DEFAULT_THEME_MODE);
    });
  });

  describe('normalizeDarkTheme', () => {
    it('passes through both dark palettes', () => {
      expect(normalizeDarkTheme('dark')).toBe('dark');
      expect(normalizeDarkTheme('midnight')).toBe('midnight');
    });

    it('inherits the palette from a legacy `theme: midnight`', () => {
      expect(normalizeDarkTheme(undefined, 'midnight')).toBe('midnight');
    });

    it('falls back for unknown values', () => {
      expect(normalizeDarkTheme('solarized', 'light')).toBe(DEFAULT_DARK_THEME);
      expect(normalizeDarkTheme(undefined, undefined)).toBe(DEFAULT_DARK_THEME);
    });
  });

  describe('normalizeAccent', () => {
    it('passes through every registered accent', () => {
      for (const name of Object.keys(ACCENTS)) {
        expect(normalizeAccent(name)).toBe(name);
      }
    });

    it('falls back to the default for unknown values', () => {
      expect(normalizeAccent('chartreuse')).toBe(DEFAULT_ACCENT);
      expect(normalizeAccent(undefined)).toBe(DEFAULT_ACCENT);
    });

    it('exposes the same accents as selectable options', () => {
      expect(ACCENT_OPTIONS.map((option) => option.value)).toEqual(Object.keys(ACCENTS));
    });
  });
});

describe('theme tokens in globals.css', () => {
  it.each(THEME_PALETTES)('declares the palette background for %s', (name) => {
    const definition = THEMES[name];
    if (name === 'light') {
      expect(LIGHT).toContain(`--color-background: ${definition.background}`);
    } else {
      const selector = name === 'dark' ? '.dark {' : `[data-theme="${name}"] {`;
      expect(block(selector)).toContain(`--color-background: ${definition.background}`);
    }
  });

  it('places the theme picker swatch on top of the real palette', () => {
    for (const [name, definition] of Object.entries(THEMES)) {
      const selector =
        name === 'light'
          ? '@theme {'
          : name === 'dark'
            ? '.dark {'
            : `[data-theme="${name}"] {`;
      const tokens = block(selector);
      expect(tokens).toContain(`--color-background: ${definition.swatch.background}`);
      expect(tokens).toContain(`--color-card: ${definition.swatch.surface}`);
      expect(tokens).toContain(`--color-foreground: ${definition.swatch.foreground}`);
    }
  });

  /**
   * A palette that omits a token silently inherits the light value, which on a
   * dark surface means invisible text. Comparing against the light `@theme`
   * block catches that at build time rather than by eye.
   */
  it('covers every base colour token in each dark palette', () => {
    const tokens = baseTokens();
    expect(tokens.length).toBeGreaterThan(20);

    for (const [name, definition] of Object.entries(THEMES)) {
      if (definition.scheme !== 'dark') continue;
      const selector = name === 'dark' ? '.dark {' : `[data-theme="${name}"] {`;
      const source = block(selector);
      const missing = tokens.filter((token) => !source.includes(`${token}:`));
      expect(missing, `${name} is missing tokens`).toEqual([]);
    }
  });

  it('declares every accent preset with its registry hue', () => {
    for (const [name, accent] of Object.entries(ACCENTS)) {
      const selector = `[data-accent="${name}"] {`;
      const source = block(selector);
      expect(source).toContain(`--accent-h: ${accent.hue};`);
      expect(source).toContain(`--accent-c: ${accent.chroma};`);
      expect(source).toContain(`--accent-l: ${accent.lightness};`);
    }
  });

  it('keeps the modal scrim dark and translucent in every palette', () => {
    for (const source of [LIGHT, DARK, MIDNIGHT]) {
      const match = source.match(/--color-overlay:\s*oklch\(([\d.]+)\s+[\d.]+\s+[\d.]+\s*\/\s*([\d.]+)\)/);
      expect(match, 'no parseable --color-overlay').not.toBeNull();
      const lightness = Number(match![1]);
      const alpha = Number(match![2]);
      // A scrim brighter than mid-grey lightens the page instead of dimming it.
      expect(lightness).toBeLessThan(0.25);
      expect(alpha).toBeGreaterThan(0.3);
      expect(alpha).toBeLessThan(0.85);
    }
  });

  it('dims harder on the dark palettes than on light', () => {
    const alpha = (source: string) =>
      Number(source.match(/--color-overlay:\s*oklch\([^)]*\/\s*([\d.]+)\)/)![1]);
    expect(alpha(DARK)).toBeGreaterThan(alpha(LIGHT));
    expect(alpha(MIDNIGHT)).toBeGreaterThan(alpha(LIGHT));
  });

  it('does not derive the scrim from a foreground or background tint', () => {
    const dialog = readFileSync(resolve(__dirname, '../components/ui/dialog.tsx'), 'utf8');
    const code = dialog.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain('bg-overlay');
    expect(code).not.toContain('bg-foreground/');
    expect(code).not.toContain('bg-black/');
  });
});

/**
 * First-paint theming (anti-FOUC).
 *
 * `theme-preload.js` cannot import the registry (it is copied verbatim and runs
 * before any module), so the contract is a `localStorage` mirror written by
 * `applyTheme`: `{ name, dark, background }`. Shipping the *background* is what
 * removed the duplicated palette table from the preload — it only keeps two
 * first-launch defaults, asserted here against the registry.
 */
describe('first-paint theming', () => {
  describe('mirror contract', () => {
    it('reads the same key the theme module writes', () => {
      const theme = readFileSync(resolve(__dirname, '../lib/theme.ts'), 'utf8');
      const key = PRELOAD.match(/var THEME_KEY = '([^']+)'/);
      expect(key, 'THEME_KEY not found in preload').not.toBeNull();
      expect(theme).toContain(`MIRROR_KEY = '${key![1]}'`);
      expect(theme).toContain('localStorage.setItem(MIRROR_KEY');
    });

    it('reads the same accent key the theme module writes', () => {
      const theme = readFileSync(resolve(__dirname, '../lib/theme.ts'), 'utf8');
      const key = PRELOAD.match(/var ACCENT_KEY = '([^']+)'/);
      expect(key, 'ACCENT_KEY not found in preload').not.toBeNull();
      expect(theme).toContain(`ACCENT_MIRROR_KEY = '${key![1]}'`);
      expect(theme).toContain('localStorage.setItem(ACCENT_MIRROR_KEY');
    });

    it('mirrors the resolved palette rather than the preference', () => {
      const theme = readFileSync(resolve(__dirname, '../lib/theme.ts'), 'utf8');
      expect(theme).toMatch(/const mirror: ThemeMirror = \{[\s\S]*?name: resolved,\s*dark,\s*background: definition\.background,/);
    });

    it('pins its first-launch defaults to the registered palettes', () => {
      const table = PRELOAD.match(/var FALLBACK = \{([\s\S]*?)\n  \};/);
      expect(table, 'no FALLBACK table found').not.toBeNull();
      const source = table![1]!;
      for (const name of ['light', 'dark'] as const) {
        expect(source, `${name} default missing`).toContain(THEMES[name].background);
        expect(source).toContain(`dark: ${THEMES[name].scheme === 'dark'}`);
      }
    });

    it('knows every accent the registry can persist', () => {
      const list = PRELOAD.match(/var ACCENTS = \[([^\]]*)\]/);
      expect(list, 'no ACCENTS list').not.toBeNull();
      const names = [...list![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      expect(names).toEqual(Object.keys(ACCENTS));
    });
  });

  describe('preload script', () => {
    it('sets both channels `applyTheme` uses', () => {
      // A `data-theme` without `.dark` leaves Tailwind's `dark:` utilities and
      // the Shiki overrides on their light values against a dark surface.
      expect(PRELOAD).toContain("classList.add('dark')");
      expect(PRELOAD).toContain("setAttribute('data-theme'");
      expect(PRELOAD).toContain("setAttribute('data-accent'");
    });

    it('honours a pre-JSON mirror without losing the light/dark choice', () => {
      // Older builds stored a bare palette name; upgrading must not flash the
      // opposite scheme before `bootstrapPage` corrects it.
      expect(PRELOAD).toContain("mirrored === 'midnight'");
      expect(PRELOAD).toContain("mirrored === 'light' ? FALLBACK.light : FALLBACK.dark");
    });

    it('validates the mirrored payload before painting it', () => {
      expect(PRELOAD).toContain('JSON.parse(mirrored)');
      expect(PRELOAD).toContain('typeof parsed.background');
      expect(PRELOAD).toContain('typeof parsed.dark');
    });

    it('survives localStorage being unavailable', () => {
      expect(PRELOAD).toMatch(/try\s*{[^}]*localStorage\.getItem/);
    });

    it('paints inline so it works without a stylesheet', () => {
      expect(PRELOAD).toMatch(/root\.style\.backgroundColor\s*=\s*resolved\.background/);
      expect(PRELOAD).toMatch(/root\.style\.colorScheme\s*=\s*resolved\.dark\s*\?\s*'dark'\s*:\s*'light'/);
      expect(PRELOAD).toContain("setAttribute('data-theme-preload', '')");
    });
  });

  describe('injection via theme-preload-plugin', () => {
    const plugin = themePreloadPlugin();

    it('is wired into the Vite config', () => {
      const config = readFileSync(resolve(__dirname, '../wxt.config.ts'), 'utf8');
      expect(config).toContain('themePreloadPlugin()');
      expect(config).toContain('import { themePreloadPlugin }');
    });

    it('is a transformIndexHtml plugin, not a runtime tag', () => {
      expect(typeof plugin.transformIndexHtml).toBe('object');
      const descriptor = plugin.transformIndexHtml as { order?: string; handler?: unknown };
      expect(descriptor.order).toBe('pre');
      expect(typeof descriptor.handler).toBe('function');
    });

    it('prepends a synchronous script that loads theme-preload.js', () => {
      const descriptor = plugin.transformIndexHtml as {
        handler: (html: string) => unknown;
      };
      const tags = descriptor.handler(
        '<!doctype html><html><head></head><body></body></html>',
      ) as Array<{ tag?: string; injectTo?: string; attrs?: unknown }>;
      expect(tags).toHaveLength(1);
      // No `type="module"`/`defer`: a module script is implicitly deferred and
      // would run after first paint, silently restoring the flash.
      expect(tags[0]).toMatchObject({ tag: 'script', injectTo: 'head-prepend' });
      expect(tags[0]!.attrs).toEqual({ src: '/theme-preload.js' });
    });

    it('is idempotent when the script is already present', () => {
      const descriptor = plugin.transformIndexHtml as {
        handler: (html: string) => unknown;
      };
      expect(
        descriptor.handler('<head><script src="/theme-preload.js"></script></head>'),
      ).toEqual([]);
    });

    it.each(['popup', 'options', 'install'])(
      'leaves %s index.html free of a manual tag',
      (name) => {
        const html = readFileSync(resolve(__dirname, `../entrypoints/${name}/index.html`), 'utf8');
        expect(html).not.toContain('theme-preload.js');
      },
    );
  });

  describe('CSS fallback', () => {
    it('paints the canvas from `html`, not just `body`', () => {
      expect(CSS).toMatch(/html\s*{[^}]*background-color:\s*var\(--color-background\)/);
    });

    it('falls back to dark for an OS-dark system preference', () => {
      expect(CSS).toMatch(
        /@media\s*\(prefers-color-scheme:\s*dark\)\s*{\s*html:not\(\[data-theme\]\)/,
      );
    });

    it('scopes the fallback so it cannot outlive the real paint', () => {
      const start = CSS.indexOf('html:not([data-theme])');
      expect(start).toBeGreaterThan(-1);
      expect(block('html:not([data-theme])')).toContain('color-scheme: dark');
    });

    it('declares `color-scheme` on the dark palette', () => {
      expect(DARK).toContain('color-scheme: dark');
    });
  });

  describe('render gate', () => {
    it('paints theme and accent before mounting React', () => {
      const bootstrap = readFileSync(resolve(__dirname, '../lib/page-bootstrap.ts'), 'utf8');
      expect(bootstrap).toContain('applyTheme');
      expect(bootstrap).toContain('applyAccent');
      // One read feeding every concern: they all share `uiSettings`, and reading
      // it twice made cold start the sum of two round trips.
      expect(bootstrap.match(/getUISettings/g)?.length).toBe(1);
      expect(bootstrap).toContain('applyLanguage');
    });

    it.each(['popup', 'options', 'install'])('gates the %s render on bootstrapPage', (name) => {
      const main = readFileSync(resolve(__dirname, `../entrypoints/${name}/main.tsx`), 'utf8');
      expect(main).toContain('bootstrapPage()');
      expect(main).not.toContain('initI18nFromStorage');
    });
  });
});
