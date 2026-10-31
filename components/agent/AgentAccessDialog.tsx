import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2, ShieldCheck } from 'lucide-react';
import type { AgentAccess } from '@/store/useAgentAccess';
import { shouldOpenAgentPrompt } from '@/lib/agent/prompt-policy';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';

interface AgentAccessDialogProps {
  access: AgentAccess;
}

/**
 * Approval prompt for an extension that asked to use the agent endpoint.
 *
 * The inline list in Settings → Agent remains the management surface, but a
 * security decision must not wait for the user to scroll a settings page: when
 * the background opens this page to ask, the request is presented as a
 * modal. "Later" only hides it for the current session — suppressing the
 * caller for the 24h cooldown stays an explicit action in the inline list.
 *
 * Requests are queued newest-first by the background; approving or dismissing
 * one advances to the next with a short cross-fade rather than a hard swap.
 */
export function AgentAccessDialog({ access }: AgentAccessDialogProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const { settings, actionable, approve } = access;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Requests the user pushed aside for this session only. */
  const deferred = useRef(new Set<string>());
  /** Set once the dialog has interrupted, so remaining queue items follow it in. */
  const engaged = useRef(false);

  const current = actionable[0];
  const currentId = current?.id;

  useEffect(() => {
    if (!current) {
      engaged.current = false;
      setOpen(false);
      return;
    }
    const shouldOpen = shouldOpenAgentPrompt({
      request: current,
      settings,
      now: Date.now(),
      open,
      engaged: engaged.current,
      deferred: deferred.current,
    });
    if (!shouldOpen) return;
    engaged.current = true;
    setOpen(true);
  }, [current, open, settings]);

  useEffect(() => {
    setError(null);
  }, [currentId]);

  const defer = () => {
    if (currentId) deferred.current.add(currentId);
    setOpen(false);
  };

  const runApprove = async () => {
    if (!currentId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await approve(currentId);
      toast({ title: t('settings.agent.approved'), variant: 'success' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const client = current?.name || t('settings.agent.unknownClient');
  const scope = t(
    settings?.allowWrites
      ? 'settings.agent.requestDialog.scopeWrite'
      : 'settings.agent.requestDialog.scopeRead',
  );

  return (
    <Dialog open={open && Boolean(current)} onOpenChange={(next) => !next && defer()}>
      <DialogContent role="alertdialog" showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            >
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <DialogTitle>{t('settings.agent.requestDialog.title')}</DialogTitle>
                {actionable.length > 1 && (
                  <Badge variant="accent" className="mt-0.5 tabular-nums">
                    {t('settings.agent.requestDialog.queued', { count: actionable.length - 1 })}
                  </Badge>
                )}
              </div>
              {current && (
                <DialogDescription className="mt-1">
                  {t('settings.agent.requestDialog.description', { client, scope })}
                </DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>

        <AnimatePresence mode="wait" initial={false}>
          {current && (
            <motion.div
              key={current.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14, ease: [0.2, 0, 0, 1] }}
              className="flex flex-col gap-2"
            >
              <div className="rounded-control border border-border bg-muted/40 px-3 py-2.5">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <p className="min-w-0 truncate text-sm font-medium text-foreground">{client}</p>
                  {current.version && <Badge variant="outline">{current.version}</Badge>}
                </div>
                <code className="mt-1 block select-all truncate font-mono text-2xs text-muted-foreground">
                  {current.id}
                </code>
              </div>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                {t('settings.agent.requestDialog.grants')}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {error && (
          <p role="alert" className="text-xs leading-relaxed text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={defer} disabled={busy}>
            {t('settings.agent.requestDialog.later')}
          </Button>
          <Button onClick={() => void runApprove()} disabled={busy}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            {t('settings.agent.approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
