import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Width of the *content column*. The page frame itself is always 100% wide.
 *
 * `full`    — surfaces that earn every pixel: the code editor.
 * `content` — lists and tables; 74rem is where a row stops being scannable.
 * `form`    — settings and metadata forms; 48rem keeps the label and its
 *             control within one comfortable eye movement.
 */
export type PageWidth = 'full' | 'content' | 'form';

const WIDTH_CLASS: Record<PageWidth, string> = {
  full: 'w-full',
  content: 'w-full max-w-[74rem]',
  form: 'w-full max-w-3xl',
};

/**
 * Page frame for every options surface.
 *
 * Two decisions worth naming:
 *  - The heading is sticky. On a 600-row script list the page heading is the only
 *    thing that says where you are; letting it scroll away is how long pages
 *    become disorienting.
 *  - The rule between heading and content spans the *full* window, while the
 *    column below it is capped per page. A divider that stops at 74rem reads as
 *    a card edge, not as the frame of the application. The heading text is
 *    aligned to the same column as the content (same left padding, same cap), so
 *    the eye still gets one vertical line to follow.
 */
export function PageLayout({
  header,
  children,
  className,
  contentClassName,
  width = 'content',
}: {
  header: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  width?: PageWidth;
}) {
  return (
    <div className={cn('flex min-h-full w-full flex-col', className)}>
      <div className="sticky top-0 z-20 shrink-0 border-b border-border bg-background/85 backdrop-blur-md">
        <div className={cn(WIDTH_CLASS[width], 'px-5 py-3.5 sm:px-7')}>{header}</div>
      </div>
      <div
        className={cn(
          WIDTH_CLASS[width],
          'min-w-0 flex-1 px-5 py-5 sm:px-7 sm:py-6',
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
