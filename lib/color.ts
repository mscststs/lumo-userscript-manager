/**
 * Colour conversion for surfaces that cannot use CSS.
 *
 * The service worker paints the toolbar badge through `chrome.action`, which
 * takes a plain CSS colour string and (in the implemented range) does not parse
 * `oklch()`. The product's palette is OKLCH end to end, so the one place that
 * has to leave CSS needs its own conversion rather than a second hand-tuned hex
 * table that would drift from `assets/globals.css`.
 */

/** Clamp + gamma-encode one linear sRGB channel into 0–255. */
function encode(linear: number): number {
  const value = Math.min(1, Math.max(0, linear));
  const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

/**
 * OKLCH → `#rrggbb`.
 *
 * Standard OKLab → LMS → linear sRGB matrices (Björn Ottosson), then the sRGB
 * transfer function. Out-of-gamut colours are clipped per channel, which is
 * what `oklch()` itself does when it renders to an sRGB surface.
 */
export function oklchToHex(lightness: number, chroma: number, hueDegrees: number): string {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;

  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;

  const red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return `#${[red, green, blue].map((channel) => encode(channel).toString(16).padStart(2, '0')).join('')}`;
}
