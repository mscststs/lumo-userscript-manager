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
 * rows is four decisions. The heading is small and uppercase because it is a
 * label, not a title — it must not compete with the page heading.
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
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </h2>
          {description && (
            <p className="mt-1 max-w-[62ch] text-xs leading-relaxed text-muted-foreground text-pretty">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="-mx-4 divide-y divide-border border-y border-border bg-card px-4 sm:mx-0 sm:rounded-card sm:border">
        {children}
      </div>
    </section>
  );
}
