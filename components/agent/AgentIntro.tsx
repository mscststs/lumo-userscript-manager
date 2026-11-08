import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, Copy, ExternalLink, Sparkles } from 'lucide-react';
import {
  LUMO_CHROME_STORE_URL,
  LUMO_EDGE_ADDONS_URL,
  LUMO_REPOSITORY_URL,
} from '@/lib/lumo-agent';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/** Store listings are the normal route; the repository is the only one that
 *  also documents the unpacked install, so it is offered last, not hidden. */
const INSTALL_LINKS = [
  { href: LUMO_CHROME_STORE_URL, labelKey: 'settings.agent.intro.stores.chrome' },
  { href: LUMO_EDGE_ADDONS_URL, labelKey: 'settings.agent.intro.stores.edge' },
  { href: LUMO_REPOSITORY_URL, labelKey: 'settings.agent.intro.stores.github' },
] as const;

/** A step's detail line is optional: step 1 hands over the install links
 *  themselves, so a sentence describing them would only repeat the buttons. */
const STEPS = [
  { id: 'install', detail: false },
  { id: 'service', detail: true },
  { id: 'id', detail: true },
] as const;

/**
 * Onboarding entry for the agent endpoint.
 *
 * Two surfaces in one component: a single row that stays collapsed (the
 * settings page is a control surface, not a tutorial), and the dialog it opens.
 * The row only exists while no extension is allowed — once a client is
 * connected the explanation has served its purpose and disappears instead of
 * becoming permanent chrome above the switches.
 *
 * Inside the dialog every step has one shape — number, title, optional line of
 * detail, then the artefact that step is about. Spacing follows a single
 * 4 / 8 / 16 scale (title→detail / detail→artefact / step→step), so the gaps
 * that group a step are never wider than the gaps that separate two steps
 * (Gestalt proximity). No rules between steps: the numbering already delimits
 * them, and a hairline on top of that reads as a table rather than a sequence.
 * Type stays on three stops (base title / sm step title / xs detail).
 */
export function AgentIntro() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Re-opening starts from a clean state; a leftover tick would claim an action
  // the user did not just take.
  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(chrome.runtime.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // A denied clipboard write is not worth a page-level error: the ID stays
      // selectable right next to the button.
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="group flex w-full items-center gap-2.5 rounded-card border border-border bg-card px-3.5 py-2.5 text-left shadow-surface transition-colors hover:border-input hover:bg-accent/40"
        >
          <Sparkles aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium leading-5 text-foreground">
              {t('settings.agent.intro.title')}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {t('settings.agent.intro.hint')}
            </span>
          </span>
          <ChevronRight
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-standard group-hover:translate-x-0.5"
          />
        </button>
      </DialogTrigger>

      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader>
          <DialogTitle>{t('settings.agent.intro.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('settings.agent.intro.lead')}</DialogDescription>
        </DialogHeader>

        <ol className="space-y-4">
          {STEPS.map((step, index) => (
            <li key={step.id} className="flex items-baseline gap-2.5">
              <span
                aria-hidden="true"
                className="w-3 shrink-0 text-xs font-medium tabular-nums text-muted-foreground"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {t(`settings.agent.intro.steps.${step.id}.title`)}
                </p>
                {step.detail && (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
                    {t(`settings.agent.intro.steps.${step.id}.description`)}
                  </p>
                )}

                {step.id === 'install' && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {INSTALL_LINKS.map((link) => (
                      <Button key={link.href} asChild variant="outline" size="sm">
                        <a href={link.href} target="_blank" rel="noreferrer">
                          {t(link.labelKey)}
                          <ExternalLink
                            aria-hidden="true"
                            className="h-3 w-3 text-muted-foreground"
                          />
                        </a>
                      </Button>
                    ))}
                  </div>
                )}

                {step.id === 'id' && (
                  <div className="mt-2 flex min-w-0 items-center gap-1.5">
                    <code className="min-w-0 flex-1 select-all truncate rounded-control border border-border bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground">
                      {chrome.runtime.id}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => void copyId()}
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
                )}
              </div>
            </li>
          ))}
        </ol>

        <DialogFooter>
          <DialogClose asChild>
            <Button>{t('settings.agent.intro.done')}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
