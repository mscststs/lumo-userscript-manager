import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ExtensionIdValueProps {
  /**
   * `field` — a take-away value that owns its row width (settings page).
   * `inline` — the same value inside a step of the walkthrough dialog.
   */
  variant?: 'field' | 'inline';
  className?: string;
}

/**
 * This extension's ID, with the one action the value exists for: copying it.
 *
 * The ID is a string the user carries *out* of this page, not a control, so it
 * must not be laid out like a switch or a select (truncated to a chip at the
 * row's trailing edge, action reduced to a bare icon). `field` gives it a
 * full-width, selectable, wrapping block whose copy affordance lives inside the
 * value — the same read as the walkthrough step, so the artefact looks
 * identical wherever it appears.
 *
 * Copy feedback is the icon's tick plus an `aria-live` status line; a toast
 * would be a page-level event for a page-level-irrelevant action.
 */
export function ExtensionIdValue({ variant = 'field', className }: ExtensionIdValueProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(chrome.runtime.id);
    } catch {
      // A denied clipboard write is not worth an error banner: the ID stays
      // selectable right next to the button.
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 rounded-control border border-border',
        variant === 'field'
          ? 'bg-background py-1.5 pe-1.5 ps-2.5'
          : 'bg-muted/50 px-2 py-1',
        className,
      )}
    >
      <code
        dir="ltr"
        className={cn(
          // Wrapping, not truncation: a 32-character ID has no middle worth
          // showing without its ends.
          'min-w-0 flex-1 select-all font-mono text-xs',
          variant === 'field' ? 'break-all text-foreground' : 'truncate text-muted-foreground',
        )}
      >
        {chrome.runtime.id}
      </code>
      <Button
        variant="ghost"
        size="iconSm"
        className="shrink-0"
        onClick={() => void copy()}
        aria-label={t('settings.agent.copyId')}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t('settings.agent.intro.copied') : ''}
      </span>
    </div>
  );
}
