import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronRight,
  CircleCheck,
  Crosshair,
  Download,
  Globe,
  KeyRound,
  Link2,
  LoaderCircle,
  Package,
  ShieldAlert,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { InstallDraftSummary } from '@/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { BrandMark } from '@/components/brand/BrandMark';
import { ScriptIcon } from '@/components/script/ScriptIcon';
import { CodeView } from '@/components/code/CodeView';
import { sendBg } from '@/lib/messages';
import { ThemeInit } from '@/lib/theme';
import { FontSizeInit } from '@/lib/font-size';
import { cn, formatBytes } from '@/lib/utils';

type State =
  | { status: 'loading' }
  | { status: 'ready'; token: string; summary: InstallDraftSummary; installing: boolean }
  | { status: 'installed'; uuid: string; updated: boolean; summary: InstallDraftSummary }
  | { status: 'error'; message: string };

function isFramed(): boolean {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
}

/** One page-level state swap: a short settle, never a slide across the page. */
const STATE_MOTION = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const },
};

/**
 * Install / update review.
 *
 * The page answers one question — "what will this script be allowed to do?" —
 * so it reads top to bottom as identity, capabilities, source, decision. The
 * decision bar stays pinned to the bottom edge: the code preview can be
 * thousands of lines long, and the install button must not scroll away with it.
 *
 * Installing keeps the review on screen and turns the button into its own
 * progress indicator; the page only changes shape once there is a result.
 */
export default function App() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [enabled, setEnabled] = useState(true);
  const params = useMemo(() => new URLSearchParams(location.search), []);

  useEffect(() => {
    if (isFramed()) {
      setState({ status: 'error', message: t('install.frameBlocked') });
      return;
    }
    const token = params.get('token');
    // DNR substitution cannot URL-encode the original URL. Read the raw suffix
    // so query parameters in the script URL are not truncated by URLSearchParams.
    const rawSearch = location.search;
    const src = rawSearch.startsWith('?src=')
      ? rawSearch.slice('?src='.length)
      : params.get('src');
    if (!token && !src) {
      setState({ status: 'error', message: t('install.invalidSource') });
      return;
    }

    if (token) {
      sendBg<InstallDraftSummary & { token: string }>('install:getDraft', { token })
        .then((draft) => {
          if (!draft) throw new Error(t('install.invalidSource'));
          setState({ status: 'ready', token, summary: draft, installing: false });
        })
        .catch((error: Error) => setState({ status: 'error', message: error.message }));
      return;
    }

    sendBg<{ token: string; summary: InstallDraftSummary }>('install:prepare', { sourceUrl: src })
      .then(({ token: nextToken, summary }) =>
        setState({ status: 'ready', token: nextToken, summary, installing: false }),
      )
      .catch((error: Error) => setState({ status: 'error', message: error.message }));
  }, [params, t]);

  const install = async () => {
    if (state.status !== 'ready' || state.installing) return;
    const { token, summary } = state;
    setState({ ...state, installing: true });
    try {
      const result = await sendBg<{ uuid: string; updated: boolean }>('install:commit', {
        token,
        enabled,
      });
      setState({ status: 'installed', uuid: result.uuid, updated: result.updated, summary });
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const retry = () => {
    location.reload();
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <ThemeInit />
      <FontSizeInit />

      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center justify-between gap-3 px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <BrandMark />
            {/* Product wordmark stays English in every locale. */}
            <span className="truncate text-sm font-semibold">Lumo Userscripts</span>
            <span aria-hidden="true" className="text-muted-foreground/60">
              /
            </span>
            <h1 className="truncate text-sm text-muted-foreground">{t('install.title')}</h1>
          </div>
          <Button
            variant="ghost"
            size="iconSm"
            onClick={() => window.close()}
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <AnimatePresence mode="wait" initial={false}>
        <motion.main
          key={state.status}
          {...STATE_MOTION}
          className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-5 pt-6"
        >
          {state.status === 'loading' && <LoadingView />}
          {state.status === 'error' && (
            <ResultCard
              tone="error"
              icon={ShieldAlert}
              title={t('install.errorTitle')}
              description={state.message}
              actions={
                <>
                  <Button variant="outline" size="sm" onClick={retry}>
                    {t('common.retry')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => window.close()}>
                    {t('common.close')}
                  </Button>
                </>
              }
            />
          )}
          {state.status === 'installed' && (
            <ResultCard
              tone="success"
              icon={CircleCheck}
              title={t('install.successTitle')}
              description={t('install.successDesc')}
              identity={state.summary}
              actions={
                <>
                  <Button size="sm" onClick={() => void chrome.runtime.openOptionsPage()}>
                    {t('install.openDashboard')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => window.close()}>
                    {t('common.close')}
                  </Button>
                </>
              }
            />
          )}
          {state.status === 'ready' && (
            <ReviewView
              summary={state.summary}
              installing={state.installing}
              enabled={enabled}
              onEnabledChange={setEnabled}
              onInstall={() => void install()}
            />
          )}
        </motion.main>
      </AnimatePresence>
    </div>
  );
}

function ReviewView({
  summary,
  installing,
  enabled,
  onEnabledChange,
  onInstall,
}: {
  summary: InstallDraftSummary;
  installing: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const grants = summary.grant.filter((grant) => grant !== 'none');
  const scope = [...summary.matches, ...summary.includes];
  const lineCount = useMemo(() => summary.code.split('\n').length, [summary.code]);

  return (
    <>
      <div className="space-y-4 pb-6">
        <section className="rounded-card border border-border bg-card p-5 shadow-surface">
          <div className="flex items-start gap-4">
            <ScriptIcon src={summary.icon} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="min-w-0 truncate text-lg font-semibold" title={summary.name}>
                  {summary.name}
                </h2>
                {summary.isUpdate ? (
                  <Badge variant="accent">
                    {t('install.update')}
                    {summary.previousVersion && (
                      <span className="tabular-nums">
                        {' '}
                        v{summary.previousVersion} → v{summary.version || '—'}
                      </span>
                    )}
                  </Badge>
                ) : (
                  summary.version && (
                    <Badge variant="outline" className="tabular-nums">
                      v{summary.version}
                    </Badge>
                  )
                )}
              </div>
              {(summary.author || summary.namespace) && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {[summary.author, summary.namespace].filter(Boolean).join(' · ')}
                </p>
              )}
              {summary.description && (
                <p className="mt-2.5 line-clamp-3 text-sm leading-relaxed text-muted-foreground text-pretty">
                  {summary.description}
                </p>
              )}
            </div>
          </div>
          <p className="mt-4 flex min-w-0 items-center gap-1.5 border-t border-border/70 pt-3 text-2xs text-muted-foreground">
            <Link2 className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate font-mono" title={summary.sourceUrl || undefined}>
              {summary.sourceUrl || t('install.localSource')}
            </span>
          </p>
        </section>

        <section className="divide-y divide-border/70 rounded-card border border-border bg-card px-4 shadow-surface">
          <Capability icon={KeyRound} title={t('install.permissions')}>
            {grants.length ? (
              <ChipList items={grants} variant="outline" />
            ) : (
              <Muted>{t('install.noPermissions')}</Muted>
            )}
          </Capability>
          <Capability icon={Globe} title={t('install.network')}>
            {summary.connect.length ? (
              <ChipList items={summary.connect} variant="accent" />
            ) : (
              <Muted>{t('install.noNetwork')}</Muted>
            )}
          </Capability>
          <Capability icon={Package} title={t('install.requires')}>
            {summary.requireDetails?.length ? (
              <ul className="space-y-1">
                {summary.requireDetails.map((item) => (
                  <li key={item.url} className="flex min-w-0 items-baseline gap-2 text-xs">
                    <span className="shrink-0 tabular-nums text-foreground">
                      {formatBytes(item.size)}
                    </span>
                    <span className="min-w-0 truncate font-mono text-muted-foreground" title={item.url}>
                      {item.url}
                    </span>
                    {item.hash && (
                      <span className="shrink-0 font-mono text-2xs text-muted-foreground/70">
                        #{item.hash.slice(0, 12)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Muted>{t('install.none')}</Muted>
            )}
          </Capability>
          <Capability icon={Crosshair} title={t('install.matches')}>
            {scope.length ? (
              <ChipList items={scope} variant="default" />
            ) : (
              <Muted>{t('install.allPages')}</Muted>
            )}
          </Capability>
        </section>

        {summary.warnings.length > 0 && (
          <section
            role="note"
            className="flex gap-2.5 rounded-card border border-warning/30 bg-warning/10 px-4 py-3"
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
            <ul className="min-w-0 space-y-1 text-xs leading-relaxed text-foreground">
              {summary.warnings.map((warning) => (
                <li key={warning} className="break-words">
                  {warning}
                </li>
              ))}
            </ul>
          </section>
        )}

        <Collapsible className="overflow-hidden rounded-card border border-border bg-card shadow-surface">
          {/* Inset focus ring: the card clips its corners, so an outset ring
              would be cut off. */}
          <CollapsibleTrigger className="group gap-2 px-4 py-3 text-sm font-medium transition-colors duration-150 ease-standard hover:bg-accent/50 focus-visible:-outline-offset-2">
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-standard group-data-[state=open]:rotate-90"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">{t('install.codePreview')}</span>
            <span className="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">
              {t('install.lines', { count: lineCount })} · {formatBytes(summary.codeSize)}
            </span>
          </CollapsibleTrigger>
          {/* Mounted on open only: highlighting a large script is the most
              expensive thing this page can do, and most installs never look. */}
          <CollapsibleContent>
            <div className="scrollbar-lumo max-h-[28rem] overflow-auto border-t border-border bg-code-bg py-3 pr-4">
              <CodeView code={summary.code} lineNumbers />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* The decision floats over the review like the list's batch bar: the
          same surface for "act on what you are looking at" everywhere. */}
      <div className="sticky bottom-0 z-10 mt-auto pb-4 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-popover/95 py-2 pl-2.5 pr-2 shadow-elev2 backdrop-blur-md">
          <label className="-ml-1.5 flex cursor-pointer items-center gap-0.5 text-sm text-foreground">
            <Checkbox
              checked={enabled}
              onCheckedChange={onEnabledChange}
              label={t('install.enableAfter')}
              disabled={installing}
            />
            <span aria-hidden="true">{t('install.enableAfter')}</span>
          </label>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => window.close()} disabled={installing}>
              {t('common.cancel')}
            </Button>
            <Button onClick={onInstall} disabled={installing} aria-busy={installing}>
              {installing ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {installing
                ? t('install.installing')
                : summary.isUpdate
                  ? t('install.updateAction')
                  : t('install.installAction')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

/** One capability: what the script may touch, in a fixed label column. */
function Capability({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-1.5 py-3">
      <div className="flex w-32 shrink-0 items-center gap-2 text-sm text-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{title}</span>
      </div>
      <div className="min-w-0 flex-1 basis-56 pt-px">{children}</div>
    </div>
  );
}

function ChipList({
  items,
  variant,
}: {
  items: string[];
  variant: 'default' | 'outline' | 'accent';
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item} variant={variant} className="max-w-full font-mono">
          <span className="truncate">{item}</span>
        </Badge>
      ))}
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

/** Shaped like the review it replaces: hero, capability rows, collapsed code. */
function LoadingView() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4" role="status" aria-busy="true" aria-label={t('install.fetching')}>
      <div className="rounded-card border border-border bg-card p-5 shadow-surface">
        <div className="flex items-start gap-4">
          <Skeleton className="h-12 w-12 rounded-[12px]" />
          <div className="min-w-0 flex-1 space-y-2 pt-1">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="mt-3 h-3.5 w-4/5" />
          </div>
        </div>
        <Skeleton className="mt-5 h-3 w-1/2" />
      </div>
      <div className="divide-y divide-border/70 rounded-card border border-border bg-card px-4 shadow-surface">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex items-center gap-4 py-3.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-1/3" />
          </div>
        ))}
      </div>
      <Skeleton className="h-11 w-full rounded-card" />
    </div>
  );
}

function ResultCard({
  tone,
  icon: Icon,
  title,
  description,
  identity,
  actions,
}: {
  tone: 'success' | 'error';
  icon: LucideIcon;
  title: string;
  description: string;
  /** The script the result is about, when there is one. */
  identity?: InstallDraftSummary;
  actions: ReactNode;
}) {
  return (
    <section
      role={tone === 'error' ? 'alert' : 'status'}
      className="rounded-card border border-border bg-card p-6 shadow-surface"
    >
      <div className="flex items-start gap-3.5">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
            tone === 'success' ? 'bg-success/12 text-success' : 'bg-destructive/12 text-destructive',
          )}
        >
          <Icon className="h-4.5 w-4.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-foreground">{title}</p>
          <p
            className={cn(
              'mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed',
              tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {description}
          </p>
          {identity && (
            <div className="mt-4 flex min-w-0 items-center gap-2.5 rounded-control border border-border/70 bg-background px-3 py-2">
              <ScriptIcon src={identity.icon} size="md" dimmed={false} />
              <span className="min-w-0 truncate text-sm font-medium">{identity.name}</span>
              {identity.version && (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  v{identity.version}
                </span>
              )}
            </div>
          )}
          <div className="mt-5 flex flex-wrap gap-2">{actions}</div>
        </div>
      </div>
    </section>
  );
}
