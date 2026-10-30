import type { ReactNode } from 'react';

interface SettingsHeaderProps {
  title: string;
  description?: string;
  /** Optional trailing control, aligned with the title block. */
  action?: ReactNode;
}

/** Page-level heading shared by every settings section. */
export function SettingsHeader({ title, description, action }: SettingsHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
        {description && (
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
