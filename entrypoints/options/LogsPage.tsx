import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Trash2 } from 'lucide-react';
import type { LogEntry } from '@/types';
import { sendBg, onLumoEvent } from '@/lib/messages';
import { formatDateTime } from '@/lib/format';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/layout/EmptyState';

const LEVEL_VARIANT: Record<string, 'default' | 'accent' | 'destructive' | 'outline'> = {
  debug: 'outline',
  info: 'accent',
  warn: 'default',
  error: 'destructive',
};

export function LogsPage() {
  const { t, i18n } = useTranslation();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

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

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return logs;
    return logs.filter(
      (entry) =>
        entry.message.toLowerCase().includes(needle) ||
        (entry.name ?? '').toLowerCase().includes(needle) ||
        entry.level.includes(needle),
    );
  }, [filter, logs]);

  const clear = async () => {
    if (!window.confirm(t('logs.clearConfirm'))) return;
    await sendBg('logs:clear');
    setLogs([]);
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <SettingsHeader
        title={t('logs.title')}
        description={t('logs.description')}
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t('common.refresh')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void clear()}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t('logs.clear')}
            </Button>
          </div>
        }
      />

      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={t('common.search')}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none"
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {loading ? (
          <p className="p-6 text-xs text-muted-foreground">{t('common.loading')}</p>
        ) : filtered.length === 0 ? (
          <EmptyState icon={Trash2} title={t('logs.empty')} description={t('logs.noLogs')} />
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((entry, index) => (
              <div key={`${entry.time}-${index}`} className="flex gap-3 px-3 py-2.5">
                <Badge variant={LEVEL_VARIANT[entry.level] ?? 'default'} className="mt-0.5 shrink-0">
                  {entry.level}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{formatDateTime(entry.time, i18n.language)}</span>
                    {entry.name && <span className="truncate text-foreground">{entry.name}</span>}
                    {entry.url && <span className="truncate">{entry.url}</span>}
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground">
                    {entry.message}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
