import { useId } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

interface SectionNavProps<T extends string> {
  items: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}

/**
 * Underline tab strip for page-level sections.
 *
 * Deliberately *not* the segmented control used for filters. Two different
 * things are being switched:
 *   segmented  → a view of the same data (全部 / 已启用 / 有更新)
 *   section nav → a different document (通用 / 更新 / 数据)
 * Giving them different shapes means the user can tell which kind of change a
 * click will cause before reading the labels (interaction normalisation cuts
 * both ways: same-looking controls must do the same *kind* of thing).
 *
 * The strip sits at the bottom edge of a page header and is pulled down one
 * pixel, so the active underline lands *on* the header rule. The underline is
 * one shared-layout object that slides between tabs — the same physics as the
 * segmented thumb and the sidebar selection — while the content below swaps
 * instantly. Every tab carries the same weight, so selecting one never
 * changes the width of its label and nudges its neighbours.
 */
export function SectionNav<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className,
}: SectionNavProps<T>) {
  const id = useId();
  const index = Math.max(
    0,
    items.findIndex((item) => item.value === value),
  );

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('-mb-px flex items-center gap-5 overflow-x-auto', className)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        const next = items[(index + delta + items.length) % items.length];
        if (next) onChange(next.value);
      }}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.value)}
            className={cn(
              'relative shrink-0 pb-2.5 pt-0.5 text-sm font-medium transition-colors duration-150 ease-standard',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
            {active && (
              <motion.span
                layoutId={`section-nav-${id}`}
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary"
                transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.7 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
