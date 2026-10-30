import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Page frame for every options surface.
 *
 * Two decisions worth naming:
 *  - The heading is sticky. On a 600-row script list the page heading is the only
 *    thing that says where you are; letting it scroll away is how long pages
 *    become disorienting.
 *  - The content column is capped at 74rem. A settings form stretched across a
 *    4K window is unreadable — the eye loses the label when it reaches the
 *    control (a 900px-wide row is far past the comfortable scanning distance).
 */
export function PageLayout({
  header,
  children,
  className,
  contentClassName,
}: {
  header: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <div className={cn('flex min-h-full w-full max-w-[74rem] flex-col', className)}>
      <div className="sticky top-0 z-20 border-b border-border bg-background/85 px-5 py-3.5 backdrop-blur-md sm:px-7">
        {header}
      </div>
      <div className={cn('min-w-0 flex-1 px-5 py-5 sm:px-7 sm:py-6', contentClassName)}>
        {children}
      </div>
    </div>
  );
}
