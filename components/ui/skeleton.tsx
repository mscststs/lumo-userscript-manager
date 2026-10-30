import { cn } from '@/lib/utils';

/**
 * Loading placeholder.
 *
 * Skeletons are sized by the caller to the *exact* height of the content they
 * replace. A skeleton of a different height is worse than no skeleton: it
 * promises a layout, then moves it (layout shift reads as a bug).
 *
 * `prefers-reduced-motion` stops the pulse rather than merely slowing it.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-md bg-muted motion-reduce:animate-none',
        className,
      )}
    />
  );
}
