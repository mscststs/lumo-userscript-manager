import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Page-level actions. Right-aligned on wide layouts, wrapped below on narrow. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Page heading shared by every options surface.
 *
 * The description is capped at 68ch (Bringhurst's comfortable measure) so a long
 * sentence never stretches into a line the eye has to track. Actions wrap below
 * the title instead of squeezing it: at rail widths the title is the thing that
 * must stay readable, and the buttons are allowed to take a second row.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-6 gap-y-3',
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="text-xl font-semibold tracking-tight text-foreground text-balance">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-muted-foreground text-pretty">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {actions}
        </div>
      )}
    </header>
  );
}
