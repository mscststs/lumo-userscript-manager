import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

/**
 * Switch (binary setting).
 *
 * Two sizes: `default` (36×20) for settings rows, `sm` (28×16) for dense popup
 * rows. The thumb stays near-white in every palette because a switch is a
 * physical, light-catcher object — a thumb that inverts with the theme reads as
 * a hole rather than a knob.
 *
 * The track uses `--color-input` when off, which is a step above the surface on
 * dark palettes: an off switch that disappears into the background is a switch
 * users forget exists.
 */
interface SwitchProps extends React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> {
  size?: 'default' | 'sm';
}

const Switch = React.forwardRef<React.ComponentRef<typeof SwitchPrimitives.Root>, SwitchProps>(
  ({ className, size = 'default', ...props }, ref) => (
    <SwitchPrimitives.Root
      ref={ref}
      className={cn(
        'peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent',
        'transition-colors duration-150 ease-standard',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        size === 'sm' ? 'h-4 w-7' : 'h-5 w-9',
        className,
      )}
      {...props}
    >
      <SwitchPrimitives.Thumb
        className={cn(
          'pointer-events-none block rounded-full bg-white shadow-elev1 ring-0',
          'transition-transform duration-150 ease-standard',
          size === 'sm'
            ? 'h-3 w-3 data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0'
            : 'h-4 w-4 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitives.Root>
  ),
);
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
