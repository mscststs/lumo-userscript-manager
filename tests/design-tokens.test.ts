import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACCENTS, THEMES, type ThemeDefinition } from '@/lib/theme-registry';

const CSS = readFileSync(resolve(__dirname, '../assets/globals.css'), 'utf8');

function block(selector: string): string {
  const start = CSS.indexOf(selector);
  expect(start, `no block for ${selector}`).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf('}', start));
}

const BLOCKS: Record<keyof typeof THEMES, string> = {
  light: block('@theme {'),
  dark: block('.dark {'),
  midnight: block('[data-theme="midnight"] {'),
};

/**
 * WCAG 2.x contrast from an OKLCH triple.
 *
 * OKLCH → Oklab → linear sRGB (Björn Ottosson's conversion), then the standard
 * relative-luminance weighting. No gamma step is needed: contrast is defined on
 * linear values. Channels are clamped because an OKLCH triple can sit slightly
 * outside sRGB at high chroma.
 */
function luminance(L: number, C: number, hue: number): number {
  const h = (hue * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const cl = (value: number) => Math.min(1, Math.max(0, value));
  const r = cl(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = cl(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = cl(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);

  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Parse a concrete `oklch(L C H)` token. Returns null for var()/calc() values. */
function oklch(source: string, token: string): [number, number, number] | null {
  const match = source.match(new RegExp(`--color-${token}:\\s*oklch\\(([^)]+)\\)`));
  if (!match) return null;
  const parts = match[1]!
    .split('/')[0]!
    .trim()
    .split(/\s+/)
    .map(Number);
  if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

const PAIRS: [string, string][] = [
  ['foreground', 'background'],
  ['muted-foreground', 'background'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['destructive-foreground', 'destructive'],
  ['success-foreground', 'success'],
  ['warning-foreground', 'warning'],
  ['sidebar-foreground', 'sidebar'],
];

describe('contrast matrix', () => {
  for (const [name, definition] of Object.entries(THEMES) as [keyof typeof THEMES, ThemeDefinition][]) {
    describe(name, () => {
      it.each(PAIRS)('%s on %s clears WCAG AA for body text', (fgToken, bgToken) => {
        const source = BLOCKS[name];
        const fg = oklch(source, fgToken);
        const bg = oklch(source, bgToken);
        expect(fg, `${name} ${fgToken} must be a concrete oklch value`).not.toBeNull();
        expect(bg, `${name} ${bgToken} must be a concrete oklch value`).not.toBeNull();

        const ratio = contrast(luminance(...fg!), luminance(...bg!));
        expect(ratio, `${name}: ${fgToken} on ${bgToken} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          4.5,
        );
      });
    });
  }
});

/**
 * Badges paint `text-<semantic>` on `bg-<semantic>/10` over a card. That tint is
 * a real surface, so the label has to clear AA against the *tint*, not against
 * the page: a colour that passes on white can fail by 0.3 once 10% of itself is
 * behind it.
 */
describe('semantic text on its own badge tint', () => {
  const tokens = ['primary', 'destructive', 'success', 'warning'] as const;

  for (const [name, definition] of Object.entries(THEMES) as [keyof typeof THEMES, ThemeDefinition][]) {
    it.each(tokens)(`${name}: %s text on its tint`, (token) => {
      const source = BLOCKS[name];
      const card = oklch(source, 'card');
      expect(card).not.toBeNull();
      const cardY = luminance(...card!);

      let colorY: number;
      if (token === 'primary') {
        // Light primary is derived from `--accent-l`; dark primary is fixed.
        const accent = ACCENTS.azure;
        colorY = luminance(
          definition.scheme === 'dark' ? 0.78 : accent.lightness,
          accent.chroma * (definition.scheme === 'dark' ? 0.78 : 1),
          accent.hue,
        );
      } else {
        const token_ = oklch(source, token);
        expect(token_, `${name} ${token}`).not.toBeNull();
        colorY = luminance(...token_!);
      }

      const tint = 0.9 * cardY + 0.1 * colorY;
      const ratio = contrast(colorY, tint);
      expect(ratio, `${name} ${token} on tint is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  }
});

/**
 * Each accent must survive as a solid button fill in both schemes. The CSS
 * derives light primary from `--accent-l` and dark primary from a fixed 0.78
 * lightness; this reconstructs both from the registry so a new accent cannot
 * ship with white-on-colour text below AA.
 */
describe('accent contrast', () => {
  it.each(Object.entries(ACCENTS))('%s keeps its solid button legible', (name, accent) => {
    // The registry and the `[data-accent]` block must agree, otherwise the
    // preview swatch and the real button are different colours.
    const source = block(`[data-accent="${name}"] {`);
    expect(source).toContain(`--accent-l: ${accent.lightness};`);
    expect(source).toContain(`--accent-h: ${accent.hue};`);
    expect(source).toContain(`--accent-c: ${accent.chroma};`);

    const lightPrimary = luminance(accent.lightness, accent.chroma, accent.hue);
    const white = luminance(0.995, 0, 0);
    expect(contrast(white, lightPrimary)).toBeGreaterThanOrEqual(4.5);

    // The dark block expresses `primary-foreground` with `var(--accent-h)`, so
    // reconstruct it from the same numbers the CSS declares.
    const darkPrimaryFg = luminance(0.185, 0.015, accent.hue);
    const darkPrimary = luminance(0.78, accent.chroma * 0.78, accent.hue);
    expect(contrast(darkPrimaryFg, darkPrimary)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('accessibility invariants', () => {
  it('never suppresses focus rings globally', () => {
    const code = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    // The old stylesheet carried `outline: none !important` for every element,
    // which is a WCAG 2.4.7 failure: keyboard users lost the pointer entirely.
    expect(code).not.toMatch(/\*\s*\{[^}]*outline:\s*none\s*!important/);
    expect(code).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-ring\)/);
  });

  it('scales the entire UI from `html` font-size', () => {
    expect(CSS).toMatch(/html\s*\{[^}]*font-size:\s*16px/);
    expect(CSS).toMatch(/--text-sm:\s*0\.8125rem/);
  });

  it('honours reduced motion', () => {
    expect(CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it('honours forced colours and high contrast', () => {
    expect(CSS).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    expect(CSS).toMatch(/@media\s*\(prefers-contrast:\s*more\)/);
  });
});
