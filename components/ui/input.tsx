import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Single-line text field.
 *
 * `bg-card` rather than `bg-background`: a field on a card is a hole punched in
 * the card, so it should read as the *page* surface coming through — on the
 * light palette that is a hair darker than the card, on dark a hair darker than
 * the card too. The border carries the affordance; hover darkens it once so the
 * control answers the pointer before it is focused.
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-8 w-full rounded-control border border-input bg-background px-2.5 text-sm text-foreground',
        'transition-[border-color,background-color] duration-150 ease-standard',
        'placeholder:text-muted-foreground',
        'hover:border-muted-foreground/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
        'aria-[invalid=true]:border-destructive',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input };
