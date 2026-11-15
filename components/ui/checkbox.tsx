import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Checkbox.
 *
 * A real `<input type="checkbox">` with `appearance: none` and a CSS-drawn
 * box/check. The native element keeps label activation, form semantics,
 * `:indeterminate`, forced-colors behaviour and screen-reader state; only the
 * pixels are ours. The 16px visual box sits inside a 28px interactive target,
 * which clears the WCAG 2.2 minimum without inflating the row.
 */
interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange' | 'type'> {
  checked: boolean;
  /** Renders a dash instead of a tick; set through the DOM property. */
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Accessible name. The visible label can live outside the control. */
  label: string;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      className,
      checked,
      indeterminate = false,
      onCheckedChange,
      onClick,
      label,
      disabled,
      ...props
    },
    forwardedRef,
  ) => {
    const innerRef = React.useRef<HTMLInputElement>(null);

    React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLInputElement);

    React.useEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    return (
      <input
        {...props}
        ref={innerRef}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onClick={(event) => {
          // Rows use the whole surface as a click target; selecting the checkbox
          // must not also open the row.
          event.stopPropagation();
          onClick?.(event);
        }}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
        className={cn('lumo-checkbox shrink-0', className)}
      />
    );
  },
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
