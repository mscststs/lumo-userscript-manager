import { cn } from '@/lib/utils';

interface SectionNavProps<T extends string> {
  items: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /**
   * Extra classes for the strip. Callers that live inside a padded header pass
   * a negative bottom margin so the active underline lands *on* the header rule
   * instead of floating above it.
   */
  className?: string;
}

/**
 * Underline tab strip for page-level sections.
 *
 * Deliberately *not* the segmented control used for filters. Two different
 * things are being switched:
 *   segmented  → a view of the same data (全部 / 已启用 / 有更新)
 *   section nav → a different document (通用 / 外观 / 更新 / 数据)
 * Giving them different shapes means the user can tell which kind of change a
 * click will cause before reading the labels (interaction normalisation cuts
 * both ways: same-looking controls must do the same *kind* of thing).
 */
export function SectionNav<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className,
}: SectionNavProps<T>) {
  const index = Math.max(
    0,
    items.findIndex((item) => item.value === value),
  );

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex items-center gap-5 overflow-x-auto', className)}
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
              'shrink-0 border-b-2 pb-1.5 pt-1 text-sm transition-colors duration-150 ease-standard',
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
