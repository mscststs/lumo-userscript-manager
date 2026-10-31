import { Children, type ReactNode } from 'react';

/**
 * Wrap bare text children in a span so every label owns a box in its flex row.
 *
 * A button row mixes an icon, a label and sometimes a count. The label needs to
 * be a box of its own for `truncate` and width transitions (the sidebar rail),
 * and the row then centres all three boxes on the same line-box centre.
 *
 * No metric-specific vertical nudge is applied: moving the label's ink relative
 * to the icon or the count breaks the shared centre, and the amount differs per
 * platform font.
 *
 * Only bare strings/numbers are wrapped; elements (icons, badges, truncation
 * spans) are left untouched so their layout is unchanged.
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
