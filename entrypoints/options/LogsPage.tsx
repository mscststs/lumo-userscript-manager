import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ScrollText, Search, Trash2, X } from 'lucide-react';
import type { LogEntry } from '@/types';
import { sendBg, onLumoEvent } from '@/lib/messages';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { EmptyState } from '@/components/layout/EmptyState';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';

type Level = 'all' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_VARIANT: Record<string, 'default' | 'accent' | 'destructive' | 'warning' | 'outline'> =
  {
    debug: 'outline',
    info: 'accent',
    warn: 'warning',
    error: 'destructive',
  };

export function LogsPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [level, setLevel] = useState<Level>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLogs(await sendBg<LogEntry[]>('logs:list', { limit: 500 }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => onLumoEvent(() => void load()), [load]);

  const counts = useMemo(() => {
    const base: Record<Level, number> = { all: logs.length, error: 0, warn: 0, info: 0, debug: 0 };
    for (const entry of logs) {
      if (entry.level in base) base[entry.level as Level] += 1;
    }
    return base;
  }, [logs]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return logs.filter((entry) => {
      if (level !== 'all' && entry.level !== level) return false;
      if (!needle) return true;
      return (
        entry.message.toLowerCase().includes(needle) ||
        (entry.name ?? '').toLowerCase().includes(needle) ||
        (entry.url ?? '').toLowerCase().includes(needle)
      );
    });
  }, [level, logs, query]);

  const clear = async () => {
    await sendBg('logs:clear');
    setLogs([]);
    toast({ title: t('logs.cleared'), variant: 'success' });
  };

  const header = (
    <PageHeader
      title={t('logs.title')}
      description={t('logs.description')}
      actions={
        <>
          <Button variant="outline" size="default" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {t('common.refresh')}
          </Button>
          <Button
            variant="outline"
            size="default"
            onClick={() => setConfirmClear(true)}
            disabled={logs.length === 0}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('logs.clear')}
          </Button>
        </>
      }
    />
  );

  return (
    <PageLayout header={header}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            className="pl-8"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('common.clear')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <Segmented
          ariaLabel={t('common.level')}
          value={level}
          onChange={setLevel}
          options={[
            { value: 'all', label: t('common.all'), count: counts.all },
            { value: 'error', label: t('settings.logLevels.error'), count: counts.error },
            { value: 'warn', label: t('settings.logLevels.warn'), count: counts.warn },
            { value: 'info', label: t('settings.logLevels.info'), count: counts.info },
            { value: 'debug', label: t('settings.logLevels.debug'), count: counts.debug },
          ]}
        />
      </div>

      {error && (
        <p role="alert" className="mt-3 whitespace-pre-wrap break-words text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="mt-3 overflow-hidden rounded-card border border-border bg-card">
        {loading ? (
          <div className="divide-y divide-border">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="flex gap-3 px-3 py-2.5">
                <div className="h-5 w-14 shrink-0 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                  <div className="h-3 w-3/4 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={query || level !== 'all' ? t('logs.noMatches') : t('logs.empty')}
            description={query || level !== 'all' ? undefined : t('logs.noLogs')}
          />
        ) : (
          <ol className="divide-y divide-border">
            {filtered.map((entry, index) => (
              <li
                key={`${entry.time}-${index}`}
                className="flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/30"
              >
                <Badge
                  variant={LEVEL_VARIANT[entry.level] ?? 'default'}
                  className="mt-0.5 w-14 shrink-0 justify-center uppercase"
                >
                  {entry.level}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
                    <time className="shrink-0 font-mono tabular-nums">
                      {formatDateTime(entry.time, i18n.language)}
                    </time>
                    {entry.name && (
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {entry.name}
                      </span>
                    )}
                    {entry.url && (
                      <span className="min-w-0 truncate font-mono opacity-80" title={entry.url}>
                        {entry.url}
                      </span>
                    )}
                  </div>
                  <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                    {entry.message}
                  </pre>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t('logs.clearConfirm')}
        confirmLabel={t('logs.clear')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={clear}
      />
    </PageLayout>
  );
}
