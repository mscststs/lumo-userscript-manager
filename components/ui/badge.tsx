import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Compact status/metadata pill.
 *
 * Tints are 10–12% of the semantic colour with a matching border, which keeps
 * a badge readable as a *category* rather than as a button. Variants map 1:1 to
 * meaning so log levels and script states cannot accidentally share a colour.
 */
const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-2xs font-medium leading-tight',
  {
    variants: {
      variant: {
        /** Neutral metadata — namespace, counts, sizes. */
        default: 'border-transparent bg-muted text-muted-foreground',
        /** Accent-tinted capability — version, "update available". */
        accent: 'border-primary/25 bg-primary/10 text-primary',
        /** Positive state — enabled, installed, healthy. */
        success: 'border-success/25 bg-success/10 text-success',
        /** Caution — updates staged, non-fatal warnings. */
        warning: 'border-warning/30 bg-warning/10 text-warning',
        /** Problems that need the user's attention. */
        destructive: 'border-destructive/25 bg-destructive/10 text-destructive',
        /** Low-emphasis label that still needs an edge to read as a chip. */
        outline: 'border-border bg-transparent text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
