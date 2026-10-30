import { Children, type ReactNode } from 'react';

/**
 * Wrap bare text children in a span that optically centres CJK labels against
 * an adjacent icon.
 *
 * An SVG icon is centred on its own geometry, but a line box centres ink
 * asymmetrically by an amount that depends on the font's ascent/descent versus
 * its ideographic ink box. `lib/optical.ts` measures that difference with the
 * font actually painting the label and publishes it as a CSS variable, so this
 * class carries no magic number of its own.
 *
 * Only bare strings/numbers are wrapped; elements (icons, badges, truncation
 * spans) are left untouched so their layout is unchanged. The nudge is
 * language-scoped in CSS (`:lang(zh)`), so English labels are not moved.
 */
export function opticalLabels(children: ReactNode): ReactNode {
  return Children.map(children, (child) =>
    typeof child === 'string' || typeof child === 'number' ? (
      <span className="text-optical">{child}</span>
    ) : (
      child
    ),
  );
}

/** Inline-label variant for places that already own the surrounding span. */
export function opticalLabelClass(className?: string): string {
  return className ? `text-optical ${className}` : 'text-optical';
}
