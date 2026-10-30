import { cn } from '@/lib/utils';

/**
 * Keyboard key cap.
 *
 * Used for shortcuts (⌘K, Esc) where the glyph *is* the instruction — the one
 * place a keyboard hint is not explanatory clutter.
 */
export function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-[0.3rem] border border-border bg-muted px-1',
        'font-mono text-2xs font-medium leading-none text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
