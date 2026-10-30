import * as React from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  /** Optional trailing count, e.g. the number of errors in a log filter. */
  count?: number;
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  size?: 'sm' | 'default';
}

/**
 * Segmented control — a radio group wearing a single control's outline.
 *
 * Used where the choice set is small (2–5), mutually exclusive, and always
 * visible: filters, settings sub-sections, view modes. A select would hide the
 * options behind a click (Hick's law cuts both ways — hiding choices also hides
 * that they exist), and separate buttons would imply independent toggles.
 *
 * The moving indicator is a *shared layout* animation, so the selection reads as
 * one object physically sliding between slots rather than two buttons blinking.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  size = 'default',
}: SegmentedProps<T>) {
  const id = React.useId();
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (activeIndex + delta + options.length) % options.length;
    const next = options[nextIndex];
    if (next) onChange(next.value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-control border border-border bg-muted p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[0.3rem] px-2 font-medium',
              'transition-colors duration-150 ease-standard',
              size === 'sm' ? 'h-6 text-2xs' : 'h-7 text-xs',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId={`segmented-${id}`}
                aria-hidden="true"
                className="absolute inset-0 rounded-[0.3rem] border border-border/60 bg-card shadow-elev1"
                transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.7 }}
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {Icon && <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />}
              {typeof option.label === 'string' || typeof option.label === 'number' ? (
                <span className="text-optical">{option.label}</span>
              ) : (
                option.label
              )}
              {option.count !== undefined && (
                <span className="tabular-nums text-muted-foreground">{option.count}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
