import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The raw userscript metadata tag (`@match`, `@run-at`, …) as a tiny chip.
 *
 * This is the tooltip anchor for metadata fields, and deliberately so: a chip
 * that reads `@noframes` is *not* self-explanatory, while the field label
 * ("Do not run in frames") already is. Putting the long explanation behind the
 * cryptic token keeps the form free of paragraphs that repeat the label, which
 * is the rule the rest of the product follows.
 *
 * Rendered as a button (not a span) so it is focusable and the tooltip is
 * reachable by keyboard; it has no click action of its own.
 */
export function MetaTag({
  tag,
  tip,
  className,
}: {
  /** Tag name without the leading `@`. */
  tag: string;
  /** Tooltip body: accepted syntax, allowed values, inherited behaviour. */
  tip?: ReactNode;
  className?: string;
}) {
  const chip = cn(
    'inline-flex max-w-full shrink-0 items-center rounded border border-border bg-muted/60 px-1 font-mono text-2xs font-normal leading-4 text-muted-foreground',
    className,
  );

  if (!tip) {
    return <span className={chip}>@{tag}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(chip, 'cursor-help transition-colors hover:text-foreground')}
        >
          @{tag}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[26rem]">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}
