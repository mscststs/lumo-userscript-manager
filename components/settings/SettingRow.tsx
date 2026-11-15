import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SettingRowProps {
  label: string;
  /** Stable id of the control this row labels. */
  htmlFor?: string;
  /** One sentence of consequence, not an instruction. Omitted when obvious. */
  description?: string;
  control: ReactNode;
  className?: string;
}

/**
 * Label + control pair used by settings screens.
 *
 * The row wraps instead of shrinking: at rail widths the control drops to its
 * own line rather than truncating the label to "Enable script…". Labels are the
 * only thing on the row that cannot be recovered by looking elsewhere, so they
 * get priority over the control's inline position.
 */
export function SettingRow({
  label,
  htmlFor,
  description,
  control,
  className,
}: SettingRowProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-2.5',
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-52">
        {/* A <label> without a for/id pair is not associated with anything:
            clicking it focuses nothing and screen readers cannot connect it to
            the control. When a call site only provides an aria-label on the
            control, the text is a plain caption instead. */}
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="block text-sm font-medium leading-5 text-foreground"
          >
            {label}
          </label>
        ) : (
          <span className="block text-sm font-medium leading-5 text-foreground">
            {label}
          </span>
        )}
        {description && (
          <p className="mt-0.5 max-w-[62ch] text-xs leading-relaxed text-muted-foreground text-pretty">
            {description}
          </p>
        )}
      </div>
      <div className="flex min-w-0 max-w-full items-center">{control}</div>
    </div>
  );
}
