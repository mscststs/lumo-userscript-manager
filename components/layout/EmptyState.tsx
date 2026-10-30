import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Optional action rendered below the copy. */
  action?: ReactNode;
  className?: string;
}

/**
 * Shared empty / fallback surface.
 *
 * Deliberately quiet: one icon, one sentence of state, and nothing that looks
 * like a call to action unless a real action is supplied. The copy explains
 * *what will appear here*, never *what to click* — the surrounding page already
 * owns the action.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-card border border-border bg-card text-muted-foreground shadow-elev1">
        <Icon className="h-4.5 w-4.5" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="mx-auto max-w-[38ch] text-xs leading-relaxed text-muted-foreground text-pretty">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
