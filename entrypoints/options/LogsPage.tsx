import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bug,
  CircleX,
  Info,
  RefreshCw,
  ScrollText,
  Search,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { LogEntry } from '@/types';
import { sendBg, onLumoEvent } from '@/lib/messages';
import {
  formatClockTime,
  formatDateTime,
  formatDayLabel,
  formatRelativeTime,
  startOfDay,
} from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { storage } from '@/store/storage';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/layout/EmptyState';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';

type Level = 'all' | 'error' | 'warn' | 'info' | 'debug';

/**
 * Severity is carried by an icon on every row and, for the two levels that
 * need attention, a rail on the row's leading edge — the rail is what the eye
 * catches when scanning a day of mostly-info output. Info and debug stay
 * unmarked so the rails keep meaning something.
 */
const LEVEL_STYLE: Record<LogEntry['level'], { icon: LucideIcon; ink: string; rail?: string }> = {
  error: { icon: CircleX, ink: 'text-destructive', rail: 'bg-destructive' },
  warn: { icon: TriangleAlert, ink: 'text-warning', rail: 'bg-warning' },
  info: { icon: Info, ink: 'text-muted-foreground' },
  debug: { icon: Bug, ink: 'text-muted-foreground/70' },
};

interface DayGroup {
  day: number;
  entries: LogEntry[];
}

export function LogsPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [level, setLevel] = useState<Level>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const now = useNow(30_000);

  // Skeleton on first load only; live reloads swap the rows in place.
  const load = useCallback(async () => {
    try {
      const entries = await sendBg<LogEntry[]>('logs:list', { limit: 500 });
      setLogs(entries);
      setError(null);
      // Everything on screen has now been seen: advance the pointer the
      // sidebar badge counts from. The newest entry's time, not `Date.now()`,
      // so an error written while this request was in flight still counts.
      const newest = entries[0]?.time;
      if (newest) void storage.setLogsSeenAt(newest).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      onLumoEvent((event) => {
        if (event === 'logs-changed') void load();
      }),
    [load],
  );

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

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

  // Entries arrive newest first, so one pass yields the days in order.
  const groups = useMemo(() => {
    const result: DayGroup[] = [];
    for (const entry of filtered) {
      const day = startOfDay(entry.time);
      const last = result[result.length - 1];
      if (last && last.day === day) last.entries.push(entry);
      else result.push({ day, entries: [entry] });
    }
    return result;
  }, [filtered]);

  const today = startOfDay(now);

  const clear = async () => {
    await sendBg('logs:clear');
    setLogs([]);
    toast({ title: t('logs.cleared'), variant: 'success' });
  };

  const header = (
    <PageHeader
      title={t('logs.title')}
      actions={
        <>
          <Button
            variant="outline"
            size="default"
            onClick={() => void refresh()}
            disabled={loading || refreshing}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
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

      {loading ? (
        <div className="mt-4">
          <Skeleton className="mb-2 h-3.5 w-20" />
          <div className="divide-y divide-border/70 rounded-card border border-border bg-card shadow-surface">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="flex gap-2.5 px-4 py-2.5">
                <Skeleton className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-2.5 w-1/3" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : groups.length === 0 ? (
        <div className="mt-3 rounded-card border border-border bg-card shadow-surface">
          <EmptyState
            icon={ScrollText}
            title={query || level !== 'all' ? t('logs.noMatches') : t('logs.empty')}
            description={query || level !== 'all' ? undefined : t('logs.noLogs')}
          />
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.day} aria-label={formatDayLabel(group.day, i18n.language, now)}>
            {/* The day heading pins to the top of the scroll area while its
                entries pass underneath, so a long day never loses its date. */}
            <h2 className="sticky top-0 z-10 -mx-1 flex items-baseline gap-2 bg-background/90 px-1 pb-2 pt-4 backdrop-blur-md">
              <span className="text-xs font-semibold text-foreground">
                {formatDayLabel(group.day, i18n.language, now)}
              </span>
              <span className="text-2xs tabular-nums text-muted-foreground">
                {group.entries.length}
              </span>
            </h2>
            <ol className="divide-y divide-border/70 overflow-hidden rounded-card border border-border bg-card shadow-surface">
              {group.entries.map((entry, index) => (
                <LogRow
                  key={entry.id ?? `${entry.time}-${index}`}
                  entry={entry}
                  relative={group.day === today}
                  locale={i18n.language}
                  now={now}
                  levelLabel={t(`settings.logLevels.${entry.level}`)}
                />
              ))}
            </ol>
          </section>
        ))
      )}

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

function LogRow({
  entry,
  relative,
  locale,
  now,
  levelLabel,
}: {
  entry: LogEntry;
  /** Today's entries read as distance ("5 minutes ago"); older ones as a clock. */
  relative: boolean;
  locale: string;
  now: number;
  levelLabel: string;
}) {
  const style = LEVEL_STYLE[entry.level] ?? LEVEL_STYLE.info;
  const Icon = style.icon;

  return (
    <li className="relative flex items-start gap-2.5 px-4 py-2.5">
      {style.rail && (
        <span
          aria-hidden="true"
          className={cn('absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full', style.rail)}
        />
      )}
      <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', style.ink)} aria-hidden="true" />
      <span className="sr-only">{levelLabel}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-x-2 text-2xs text-muted-foreground">
          {entry.name && (
            <span className="max-w-[45%] shrink-0 truncate font-medium text-foreground">
              {entry.name}
            </span>
          )}
          {entry.url && (
            <span className="min-w-0 flex-1 truncate font-mono opacity-80" title={entry.url}>
              {entry.url}
            </span>
          )}
          <time
            dateTime={new Date(entry.time).toISOString()}
            title={formatDateTime(entry.time, locale)}
            className="ml-auto shrink-0 pl-2 tabular-nums"
          >
            {relative ? formatRelativeTime(entry.time, locale, now) : formatClockTime(entry.time, locale)}
          </time>
        </div>
        <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
          {entry.message}
        </pre>
      </div>
    </li>
  );
}
