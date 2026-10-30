import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileCode2, RefreshCw, ShieldAlert, X } from 'lucide-react';
import type { InstallDraftSummary } from '@/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { sendBg } from '@/lib/messages';
import { formatBytes } from '@/lib/utils';

type State =
  | { status: 'loading' }
  | { status: 'ready'; token: string; summary: InstallDraftSummary }
  | { status: 'installing' }
  | { status: 'installed'; uuid: string; updated: boolean }
  | { status: 'error'; message: string };

function isFramed(): boolean {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
}

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
          setState({ status: 'ready', token, summary: draft });
        })
        .catch((error: Error) => setState({ status: 'error', message: error.message }));
      return;
    }

    sendBg<{ token: string; summary: InstallDraftSummary }>('install:prepare', { sourceUrl: src })
      .then(({ token: nextToken, summary }) =>
        setState({ status: 'ready', token: nextToken, summary }),
      )
      .catch((error: Error) => setState({ status: 'error', message: error.message }));
  }, [params, t]);

  const install = async () => {
    if (state.status !== 'ready') return;
    setState({ status: 'installing' });
    try {
      const result = await sendBg<{ uuid: string; updated: boolean }>('install:commit', {
        token: state.token,
        enabled,
      });
      setState({ status: 'installed', uuid: result.uuid, updated: result.updated });
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const retry = () => {
    location.reload();
  };

  return (
    <div className="min-h-screen bg-background px-6 py-8 text-foreground">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
              <FileCode2 className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-base font-semibold">{t('install.title')}</h1>
              <p className="text-xs text-muted-foreground">{t('install.subtitle')}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => window.close()}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        {state.status === 'loading' && (
          <div className="rounded-lg border border-border bg-card p-6">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              {t('install.fetching')}
            </p>
          </div>
        )}

        {state.status === 'error' && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6">
            <p className="flex items-center gap-2 text-sm font-medium text-destructive">
              <ShieldAlert className="h-4 w-4" />
              {t('install.errorTitle')}
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive/90">
              {state.message}
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" size="sm" onClick={retry}>
                {t('common.retry')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => window.close()}>
                {t('common.close')}
              </Button>
            </div>
          </div>
        )}

        {state.status === 'ready' && (
          <>
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <FileCode2 className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-sm font-semibold">{state.summary.name}</h2>
                    {state.summary.version && <Badge variant="outline">v{state.summary.version}</Badge>}
                    {state.summary.isUpdate && <Badge variant="accent">{t('install.update')}</Badge>}
                    {state.summary.isUpdate && state.summary.previousVersion && (
                      <Badge variant="default">
                        v{state.summary.previousVersion} → v{state.summary.version || '—'}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {[state.summary.namespace, state.summary.author].filter(Boolean).join(' · ')}
                  </p>
                  {state.summary.description && (
                    <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                      {state.summary.description}
                    </p>
                  )}
                  <p className="mt-2 truncate text-[11px] text-muted-foreground">
                    {state.summary.sourceUrl || t('install.localSource')}
                  </p>
                </div>
              </div>

              <Separator className="my-4" />

              <div className="grid gap-3 text-xs sm:grid-cols-2">
                <InfoBlock title={t('install.permissions')}>
                  {state.summary.grant.length && !state.summary.grant.includes('none') ? (
                    <div className="flex flex-wrap gap-1">
                      {state.summary.grant.map((grant) => (
                        <Badge key={grant} variant="outline">
                          {grant}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">{t('install.noPermissions')}</span>
                  )}
                </InfoBlock>
                <InfoBlock title={t('install.network')}>
                  {state.summary.connect.length ? (
                    <div className="flex flex-wrap gap-1">
                      {state.summary.connect.map((host) => (
                        <Badge key={host} variant="accent">
                          {host}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">{t('install.noNetwork')}</span>
                  )}
                </InfoBlock>
                <InfoBlock title={t('install.requires')}>
                  {state.summary.requireDetails?.length ? (
                    <div className="space-y-1">
                      {state.summary.requireDetails.map((item) => (
                        <div key={item.url} className="break-all text-muted-foreground">
                          <span className="text-foreground">{formatBytes(item.size)}</span> · {item.url}
                          {item.hash && (
                            <span className="ml-1 text-[10px] opacity-70">
                              #{item.hash.slice(0, 12)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">{t('install.none')}</span>
                  )}
                </InfoBlock>
                <InfoBlock title={t('install.matches')}>
                  <span className="break-all text-muted-foreground">
                    {[...state.summary.matches, ...state.summary.includes].join(', ') ||
                      t('install.allPages')}
                  </span>
                </InfoBlock>
              </div>

              {state.summary.warnings.length > 0 && (
                <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-[11px] text-muted-foreground">
                  {state.summary.warnings.map((warning) => (
                    <p key={warning}>• {warning}</p>
                  ))}
                </div>
              )}
            </div>

            <details className="rounded-lg border border-border bg-card">
              <summary className="cursor-pointer select-none px-4 py-3 text-xs font-medium">
                {t('install.codePreview')}
              </summary>
              <pre className="max-h-72 overflow-auto border-t border-border p-4 text-[11px] leading-relaxed scrollbar-lumo">
                {state.summary.code}
              </pre>
            </details>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                {t('install.enableAfter')}
              </label>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => window.close()}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" onClick={() => void install()}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {state.summary.isUpdate ? t('install.updateAction') : t('install.installAction')}
                </Button>
              </div>
            </div>
          </>
        )}

        {state.status === 'installing' && (
          <div className="rounded-lg border border-border bg-card p-6">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              {t('install.installing')}
            </p>
          </div>
        )}

        {state.status === 'installed' && (
          <div className="rounded-lg border border-border bg-card p-6">
            <p className="text-sm font-medium text-foreground">{t('install.successTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('install.successDesc')}</p>
            <div className="mt-4 flex gap-2">
              <Button size="sm" onClick={() => void chrome.runtime.openOptionsPage()}>
                {t('install.openDashboard')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => window.close()}>
                {t('common.close')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="break-words text-xs">{children}</div>
    </div>
  );
}
