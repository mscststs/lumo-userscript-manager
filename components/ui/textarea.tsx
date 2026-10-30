import * as React from 'react';
import { cn } from '@/lib/utils';

/** Multi-line text field. Same surface logic as `Input`. */
const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-20 w-full resize-y rounded-control border border-input bg-background px-2.5 py-2 text-sm leading-relaxed text-foreground',
        'transition-[border-color,background-color] duration-150 ease-standard',
        'placeholder:text-muted-foreground',
        'hover:border-muted-foreground/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-destructive',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export { Textarea };
