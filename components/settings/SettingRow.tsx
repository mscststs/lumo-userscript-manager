import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SettingRowProps {
  label: string;
  /** Stable id of the control this row labels. */
  htmlFor?: string;
  control: ReactNode;
  className?: string;
}

/**
 * Label + control pair used by settings screens.
 *
 * The control is always right-aligned and never allowed to shrink the label to
 * unreadable widths, which is what keeps rows intact at side-panel widths.
 */
export function SettingRow({ label, htmlFor, control, className }: SettingRowProps) {
  return (
    <div
      className={cn(
        'flex min-h-11 items-center justify-between gap-6 py-3',
        className,
      )}
    >
      <label htmlFor={htmlFor} className="min-w-0 truncate text-sm text-foreground">
        {label}
      </label>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
