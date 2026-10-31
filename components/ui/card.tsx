import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Card / surface primitives.
 *
 * Grouping is carried by a shared region (Gestalt: common region), not by
 * spacing alone — a settings block with eight rows is unreadable without a
 * boundary, and a boundary made only of whitespace is indistinguishable from a
 * section break.
 *
 * Two variants:
 *   `flat`     — border + `shadow-surface`. The default for lists and settings
 *                blocks: the card rests on the panel (a contact shadow on light
 *                palettes, a top highlight on dark) but does not float.
 *   `elevated` — border + `elev1`. For content that floats over the page
 *                (standalone previews, the theme picker).
 */
export function Card({
  children,
  className,
  variant = 'flat',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  variant?: 'flat' | 'elevated';
  as?: 'div' | 'section' | 'article' | 'aside';
}) {
  return (
    <Tag
      className={cn(
        'rounded-card border border-border bg-card text-card-foreground',
        variant === 'elevated' ? 'shadow-elev1' : 'shadow-surface',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-4 py-3', className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={cn('min-w-0 text-sm font-semibold text-foreground', className)}>
      {children}
    </h3>
  );
}

export function CardDescription({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn('mt-0.5 text-xs leading-relaxed text-muted-foreground', className)}>
      {children}
    </p>
  );
}

export function CardContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 pb-4', className)}>{children}</div>;
}

export function CardFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3',
        className,
      )}
    >
      {children}
    </div>
  );
}
