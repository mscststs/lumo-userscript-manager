import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SettingsGroupProps {
  title: string;
  description?: string;
  /** Rows. They are separated by hairlines, not margins. */
  children: ReactNode;
  className?: string;
  /** Right-aligned content on the group heading line. */
  action?: ReactNode;
}

/**
 * A titled block of related settings.
 *
 * Grouping exists for chunking (Miller 1956; Cowan's 4±1): a settings page with
 * 20 equal rows is one undifferentiated list, while four titled groups of ≤6
 * rows is four decisions. The heading is set at body size, one weight below
 * the page title: it names a block, it does not compete with the page heading.
 * (It used to be an 11px uppercase eyebrow, which does nothing for CJK text
 * and left a Chinese heading as the smallest type on the page.)
 */
export function SettingsGroup({
  title,
  description,
  children,
  className,
  action,
}: SettingsGroupProps) {
  return (
    <section className={cn('min-w-0', className)}>
      <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description && (
            <p className="mt-0.5 max-w-[62ch] text-xs leading-relaxed text-muted-foreground text-pretty">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="-mx-4 divide-y divide-border/70 border-y border-border bg-card px-4 sm:mx-0 sm:rounded-card sm:border sm:shadow-surface">
        {children}
      </div>
    </section>
  );
}
