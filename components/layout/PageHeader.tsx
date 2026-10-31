import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  /** Before the title: a back button, the identity icon of the open object. */
  leading?: ReactNode;
  /** Inline after the title: a version, a status badge. Never a sentence. */
  meta?: ReactNode;
  /** Page-level actions. Right-aligned; wrap below the title on narrow panels. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Page heading shared by every options surface: one line, title and actions.
 *
 * There is no description slot. The navigation already says where you are and
 * the content says what it is for; a sentence restating either is the
 * "explanatory text" the product principles rule out, and it cost every page
 * a second line of chrome above the content.
 *
 * Actions wrap below the title instead of squeezing it: at rail widths the
 * title is the thing that must stay readable, and the buttons are allowed to
 * take a second row.
 */
export function PageHeader({ title, leading, meta, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        'flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
        {leading}
        <h1 className="min-w-0 truncate text-base font-semibold text-foreground" title={title}>
          {title}
        </h1>
        {meta}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>
      )}
    </header>
  );
}
