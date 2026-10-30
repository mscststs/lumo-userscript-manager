/**
 * Optical centring for icon + label pairs.
 *
 * A flex `items-center` row centres *line boxes*, not glyph ink. Whether the
 * ink of a CJK glyph lands on that centre depends on the font's own metrics
 * (`fontBoundingBox` ascent/descent) versus its ideographic ink box, and those
 * differ per platform: Noto Sans CJK (Linux) sits ~0.09em high, PingFang SC
 * (macOS) and Microsoft YaHei (Windows) are essentially symmetric.
 *
 * A hardcoded CSS nudge therefore cannot be right everywhere — the previous
 * `0.16em` over-corrected by ~1 extra pixel at every size on macOS/Windows and
 * by ~1px on Linux, which is exactly the "label hangs below the icon" the
 * design review kept flagging.
 *
 * So the shift is measured once per page with the font that will actually
 * paint the label, expressed in `em` (font-size independent) and published as
 * `--text-optical-shift` for `.text-optical` to consume. CSS-only pages keep
 * the `0em` fallback, which degrades to plain geometric centring.
 */
const SHIFT_VARIABLE = '--text-optical-shift';

/** Reference size big enough that integer metric rounding cannot skew the ratio. */
const REFERENCE_SIZE = 100;

/** A CJK ideograph fills its em box, so its ink is the box we want centred. */
const SAMPLE = '\u56fd';

let canvas: HTMLCanvasElement | null = null;

function context(): CanvasRenderingContext2D | null {
  if (canvas) return canvas.getContext('2d');
  if (typeof document === 'undefined') return null;
  canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  return ctx && typeof ctx.measureText === 'function' ? ctx : null;
}

/**
 * Measure and publish the shift. Safe to call more than once; each call
 * re-reads the CSS font stack, so it also picks up a language- or theme-level
 * font change.
 */
export function applyOpticalShift(): void {
  if (typeof document === 'undefined' || !document.body) return;
  const ctx = context();
  if (!ctx) return;

  const { fontFamily, fontWeight } = getComputedStyle(document.body);
  if (!fontFamily) return;

  try {
    ctx.font = `${fontWeight || 400} ${REFERENCE_SIZE}px ${fontFamily}`;
    // A rejected font shorthand leaves the previous value in place; comparing
    // the size guards against measuring the canvas default (serif) instead.
    if (!ctx.font.includes(`${REFERENCE_SIZE}px`)) return;

    const metrics = ctx.measureText(SAMPLE);
    const fontAscent = metrics.fontBoundingBoxAscent;
    const fontDescent = metrics.fontBoundingBoxDescent;
    const inkAscent = metrics.actualBoundingBoxAscent;
    const inkDescent = metrics.actualBoundingBoxDescent;
    if (![fontAscent, fontDescent, inkAscent, inkDescent].every(Number.isFinite)) return;

    // Baselines cancel out: distance from the line-box centre to the ink centre
    // is ((inkAscent - inkDescent) - (fontAscent - fontDescent)) / 2.
    // Positive means the ink sits high, so the label moves down by that much.
    const shift = (inkAscent - inkDescent - (fontAscent - fontDescent)) / 2 / REFERENCE_SIZE;
    document.documentElement.style.setProperty(SHIFT_VARIABLE, `${shift.toFixed(4)}em`);
  } catch {
    // Canvas metrics are an enhancement, never a requirement.
  }
}

/** Re-measure once webfonts (if any are ever added) have finished loading. */
export function scheduleOpticalShift(): void {
  applyOpticalShift();
  void document.fonts?.ready.then(applyOpticalShift).catch(() => undefined);
}
