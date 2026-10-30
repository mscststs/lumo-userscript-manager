import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Drops one override so the value declared in the script source takes over
 * again. Only rendered when an override exists — an undo affordance that is
 * visible on untouched rows would advertise a difference that is not there.
 */
export function ResetOverride({ onReset, className }: { onReset: () => void; className?: string }) {
  const { t } = useTranslation();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onReset}
          aria-label={t('editor.resetField')}
          className={cn(
            'ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground',
            'transition-colors duration-150 ease-standard hover:bg-accent hover:text-accent-foreground',
            className,
          )}
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{t('editor.resetField')}</TooltipContent>
    </Tooltip>
  );
}
