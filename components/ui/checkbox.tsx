import * as React from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Checkbox.
 *
 * A native `<input type="checkbox">` cannot be themed reliably across the three
 * palettes (Chrome paints it from `color-scheme`, ignoring the accent), and in a
 * 44px list row it renders at an unusable 13px. This is the ARIA checkbox
 * pattern instead: `role="checkbox"` + `aria-checked`, real focus, real space
 * bar handling.
 *
 * The 16px visual box sits inside a 28px hit target, which clears the WCAG 2.2
 * target-size minimum without visually inflating the row.
 */
interface CheckboxProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  /** Renders a dash instead of a tick; `aria-checked="mixed"`. */
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label: string;
}

const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ className, checked, indeterminate = false, onCheckedChange, label, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      data-state={checked || indeterminate ? 'checked' : 'unchecked'}
      onClick={(event) => {
        event.stopPropagation();
        onCheckedChange?.(!checked);
      }}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-primary-foreground',
        'transition-colors duration-150 ease-standard',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'flex h-4 w-4 items-center justify-center rounded-[0.25rem] border transition-colors duration-150 ease-standard',
          checked || indeterminate
            ? 'border-primary bg-primary'
            : 'border-input bg-background hover:border-muted-foreground',
        )}
      >
        {indeterminate ? (
          <Minus className="h-3 w-3" strokeWidth={3} />
        ) : checked ? (
          <Check className="h-3 w-3" strokeWidth={3} />
        ) : null}
      </span>
    </button>
  ),
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
