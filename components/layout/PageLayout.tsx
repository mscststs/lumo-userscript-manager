import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Width of the *content column*. The page frame itself is always the full
 * width of the content panel.
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
 * Page frame for every options surface, laid out inside the content panel.
 *
 * Two decisions worth naming:
 *  - The heading is a fixed bar above the scroll body, not a sticky element
 *    inside it. On a 600-row script list the heading is the only thing that
 *    says where you are, so it must never scroll away; and because the
 *    scrollbar now lives *below* the heading, the rule under it runs the full
 *    width of the panel instead of stopping short at the scrollbar gutter.
 *  - That rule spans the whole panel while the column below it is capped per
 *    page. A divider that stops at 74rem reads as a card edge, not as the frame
 *    of the application. The heading is aligned to the same column as the
 *    content (same left padding, same cap), so the eye gets one vertical line.
 *
 * `scroll={false}` hands the body to a page that scrolls its own regions (the
 * code editor): the body becomes a flex column that fills the panel instead.
 */
export function PageLayout({
  header,
  children,
  className,
  contentClassName,
  width = 'content',
  scroll = true,
}: {
  header: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  width?: PageWidth;
  scroll?: boolean;
}) {
  return (
    <div className={cn('flex h-full min-h-0 w-full flex-col', className)}>
      <div className="shrink-0 border-b border-border">
        <div className={cn(WIDTH_CLASS[width], 'px-5 sm:px-7')}>{header}</div>
      </div>
      {scroll ? (
        <div className="scrollbar-lumo scroll-container min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              WIDTH_CLASS[width],
              'min-w-0 px-5 py-5 sm:px-7 sm:py-6',
              contentClassName,
            )}
          >
            {children}
          </div>
        </div>
      ) : (
        <div className={cn(WIDTH_CLASS[width], 'flex min-h-0 min-w-0 flex-1 flex-col', contentClassName)}>
          {children}
        </div>
      )}
    </div>
  );
}
