import { Children, type ReactNode } from 'react';

/**
 * Wrap bare text children in a span that optically centres CJK labels against
 * an adjacent icon.
 *
 * Why this exists: an SVG icon is centred on its own geometry, but Chinese
 * glyphs sit roughly 0.16em above the centre of the line box (their ink box is
 * centred on the ideographic box, while the line box is centred on the font's
 * ascent/descent). At 12–13px that is a visible 2px: the label reads as "high"
 * next to a plus, pencil or folder icon.
 *
 * Only bare strings/numbers are wrapped; elements (icons, badges, truncation
 * spans) are left untouched so their layout is unchanged. The nudge itself is
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
