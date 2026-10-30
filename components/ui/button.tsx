import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { opticalLabels } from '@/components/ui/optical';

/**
 * Button.
 *
 * Hierarchy is expressed with three levels, not five competing fills:
 *   primary   → one per view, the action the page exists for
 *   outline   → secondary actions that sit next to content
 *   ghost     → actions that live inside a row or toolbar
 * `secondary` remains for segmented/toolbar groups; `link` for inline prose.
 *
 * Sizing follows Fitts's law: the default target is 32px tall (24px is the
 * WCAG 2.2 minimum, 44px is the touch ideal). Dense list rows use `sm`, which
 * still clears the minimum because the whole row is also clickable.
 *
 * Focus is not styled here — `:focus-visible` is global (see globals.css) so
 * keyboard users get the same ring on buttons, inputs, links and rows.
 */
const buttonVariants = cva(
  [
    'inline-flex select-none items-center justify-center whitespace-nowrap font-medium',
    'transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-standard',
    'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45',
    '[&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-elev1 hover:bg-primary-hover',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/75',
        outline:
          'border border-input bg-card text-foreground hover:border-border hover:bg-accent hover:text-accent-foreground',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        destructive:
          'bg-destructive text-destructive-foreground shadow-elev1 hover:bg-destructive/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        /** 24px — inline chips only, never a standalone action. */
        xs: 'h-6 gap-1 rounded-md px-1.5 text-2xs',
        /** 28px — dense rows and toolbars. */
        sm: 'h-7 gap-1.5 rounded-md px-2 text-xs',
        /** 32px — the product default. */
        default: 'h-8 gap-1.5 rounded-control px-2.5 text-sm',
        /** 40px — page-level primary actions. */
        lg: 'h-10 gap-2 rounded-control px-4 text-base',
        icon: 'h-8 w-8 rounded-control',
        iconSm: 'h-7 w-7 rounded-md',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        {...props}
      >
        {asChild ? children : opticalLabels(children)}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
