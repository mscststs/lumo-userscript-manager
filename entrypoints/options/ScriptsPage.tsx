import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  FileCode2,
  FilePlus2,
  Filter,
  Link2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type { UserScript } from '@/types';
import { sendBg, onLumoEvent } from '@/lib/messages';
import { readBackupZip } from '@/lib/backup';
import { formatBytes } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import { mergeMetadata } from '@/lib/script/metadata';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/layout/EmptyState';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ScriptsPageProps {
  onOpenEditor: (uuid: string) => void;
  onOpenSettings: () => void;
}

export function ScriptsPage({ onOpenEditor, onOpenSettings }: ScriptsPageProps) {
  const { t, i18n } = useTranslation();
  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showTrash, setShowTrash] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setScripts(await sendBg<UserScript[]>('scripts:list', { includeRemoved: showTrash }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [showTrash]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => onLumoEvent((event) => {
    if (event === 'scripts-changed' || event === 'updates-checked') void load();
  }), [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scripts.filter((script) => {
      if (!needle) return true;
      return (
        script.name.toLowerCase().includes(needle) ||
        script.namespace.toLowerCase().includes(needle) ||
        script.tags.some((tag) => tag.toLowerCase().includes(needle)) ||
        [...script.metadata.match ?? [], ...script.metadata.include ?? []].some((value) =>
          value.toLowerCase().includes(needle),
        )
      );
    });
  }, [query, scripts]);

  const toggle = async (script: UserScript, enabled: boolean) => {
    try {
      await sendBg('scripts:toggle', { uuid: script.uuid, enabled });
      setScripts((prev) => prev.map((item) => (item.uuid === script.uuid ? { ...item, enabled } : item)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (script: UserScript) => {
    if (!window.confirm(t('scripts.confirmDelete'))) return;
    try {
      await sendBg('scripts:delete', { uuid: script.uuid });
      setStatus(t('scripts.trashHint'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const purge = async (script: UserScript) => {
    if (!window.confirm(t('scripts.confirmPurge'))) return;
    try {
      await sendBg('scripts:purge', { uuid: script.uuid });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const restore = async (script: UserScript) => {
    try {
      await sendBg('scripts:restore', { uuid: script.uuid });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const checkUpdates = async () => {
    setStatus(t('common.loading'));
    try {
      const result = await sendBg<{
        checked: number;
        updated: number;
        available: number;
        errors: string[];
      }>('updates:check');
      setStatus(t('scripts.checkUpdatesDone', result));
      if (result.errors?.length) setError(result.errors.join('\n'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    }
  };

  const exportBackup = async () => {
    try {
      const data = await sendBg<Record<string, unknown>>('backup:export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `lumo-userscripts-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(href);
      setStatus(t('scripts.exportDone'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setStatus(t('common.loading'));
    try {
      for (const file of Array.from(files)) {
        if (file.name.toLowerCase().endsWith('.json')) {
          const data = JSON.parse(await file.text());
          await sendBg('backup:import', { data });
        } else if (file.name.toLowerCase().endsWith('.zip')) {
          const data = readBackupZip(await file.arrayBuffer());
          await sendBg('backup:import', { data });
        } else {
          const code = await file.text();
          const { token } = await sendBg<{ token: string }>('install:prepare', { code });
          await chrome.tabs.create({ url: `${chrome.runtime.getURL('install.html')}?token=${token}` });
        }
      }
      setStatus(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    }
  };

  const installUrl = async () => {
    if (!url.trim()) {
      setStatus(t('scripts.urlRequired'));
      return;
    }
    setStatus(t('common.loading'));
    try {
      const { token } = await sendBg<{ token: string }>('install:prepare', {
        sourceUrl: url.trim(),
      });
      setUrlOpen(false);
      setUrl('');
      await chrome.tabs.create({ url: `${chrome.runtime.getURL('install.html')}?token=${token}` });
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    }
  };

  const openUpdate = (script: UserScript) => {
    if (!script.pendingInstallToken) return;
    void chrome.tabs.create({
      url: `${chrome.runtime.getURL('install.html')}?token=${script.pendingInstallToken}`,
    });
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((script) => script.uuid)));
  };

  const batch = async (action: 'enable' | 'disable' | 'delete') => {
    for (const uuid of selected) {
      const script = scripts.find((item) => item.uuid === uuid);
      if (!script) continue;
      if (action === 'delete') await sendBg('scripts:delete', { uuid });
      else await sendBg('scripts:toggle', { uuid, enabled: action === 'enable' });
    }
    setSelected(new Set());
    await load();
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <SettingsHeader
        title={t('scripts.title')}
        description={t('scripts.description')}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => void checkUpdates()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t('scripts.checkUpdates')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void exportBackup()}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {t('scripts.export')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {t('scripts.import')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setUrlOpen(true)}>
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
              {t('scripts.importUrl')}
            </Button>
            <Button size="sm" onClick={() => onOpenEditor('new')}>
              <FilePlus2 className="mr-1.5 h-3.5 w-3.5" />
              {t('scripts.new')}
            </Button>
          </div>
        }
      />

      <input
        ref={fileInput}
        type="file"
        accept=".user.js,.js,.json,.zip"
        multiple
        className="hidden"
        onChange={(event) => void importFiles(event.target.files)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('scripts.searchPlaceholder')}
            className="h-9 pl-8"
          />
        </div>
        <Button
          variant={showTrash ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => {
            setShowTrash((value) => !value);
            setSelected(new Set());
          }}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          {t('scripts.trash')}
        </Button>
      </div>

      {status && <p className="text-xs text-muted-foreground">{status}</p>}
      {error && <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <span className="text-muted-foreground">{t('scripts.selected', { count: selected.size })}</span>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => void batch('enable')}>
            {t('scripts.batchEnable')}
          </Button>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => void batch('disable')}>
            {t('scripts.batchDisable')}
          </Button>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => void batch('delete')}>
            {t('scripts.batchDelete')}
          </Button>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setSelected(new Set())}>
            {t('scripts.clearSelection')}
          </Button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {loading ? (
          <div className="p-6 text-xs text-muted-foreground">{t('common.loading')}</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={showTrash ? Trash2 : FileCode2}
            title={showTrash ? t('scripts.emptyTrashTitle') : t('scripts.emptyTitle')}
            description={
              showTrash ? t('scripts.emptyTrashDescription') : t('scripts.emptyDescription')
            }
            action={
              !showTrash ? (
                <Button size="sm" onClick={() => onOpenEditor('new')}>
                  {t('scripts.new')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={selected.size === filtered.length && filtered.length > 0}
                onChange={toggleAll}
                aria-label={t('scripts.selectAll')}
              />
              <span className="flex-1">{t('common.name')}</span>
              <span className="hidden w-20 text-right sm:block">{t('common.version')}</span>
              <span className="hidden w-24 text-right md:block">{t('common.status')}</span>
              <span className="w-8" />
            </div>
            <div className="divide-y divide-border">
              {filtered.map((script) => (
                <div key={script.uuid} className="flex items-center gap-2 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(script.uuid)}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(script.uuid)) next.delete(script.uuid);
                        else next.add(script.uuid);
                        return next;
                      })
                    }
                    aria-label={script.name}
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onOpenEditor(script.uuid)}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">{script.name}</span>
                      {script.version && <Badge variant="outline">v{script.version}</Badge>}
                      {script.updateState === 'update-available' && (
                        <Badge variant="accent">{t('scripts.updateAvailable')}</Badge>
                      )}
                      {!script.enabled && <Badge variant="default">{t('common.disabled')}</Badge>}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {script.namespace || t('scripts.noSource')}
                      {script.tags.length ? ` · ${script.tags.join(', ')}` : ''}
                      {` · ${formatBytes(script.codeSize)}`}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {(() => {
                        const effective = mergeMetadata(script.metadata, script.selfMetadata);
                        return (
                          [...effective.match ?? [], ...effective.include ?? []]
                            .slice(0, 2)
                            .join(', ') || t('install.allPages')
                        );
                      })()}
                    </div>
                    {script.lastError && (
                      <p className="mt-1 line-clamp-1 text-[11px] text-destructive">{script.lastError}</p>
                    )}
                  </button>
                  <span className="hidden w-20 text-right text-[11px] text-muted-foreground sm:block">
                    {script.version || '—'}
                  </span>
                  <span className="hidden w-24 text-right text-[11px] text-muted-foreground md:block">
                    {formatDateTime(script.updatedAt, i18n.language)}
                  </span>
                  <div className="flex w-20 shrink-0 items-center justify-end gap-1">
                    <Switch
                      checked={script.enabled && !script.removedAt}
                      disabled={Boolean(script.removedAt)}
                      onCheckedChange={(checked) => void toggle(script, checked)}
                      aria-label={t('scripts.toggle')}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {script.removedAt ? (
                          <>
                            <DropdownMenuItem onClick={() => void restore(script)}>
                              {t('scripts.restore')}
                            </DropdownMenuItem>
                            <DropdownMenuItem destructive onClick={() => void purge(script)}>
                              {t('scripts.purge')}
                            </DropdownMenuItem>
                          </>
                        ) : (
                          <>
                            <DropdownMenuItem onClick={() => onOpenEditor(script.uuid)}>
                              {t('scripts.edit')}
                            </DropdownMenuItem>
                            {script.updateState === 'update-available' && script.pendingInstallToken && (
                              <DropdownMenuItem onClick={() => openUpdate(script)}>
                                {t('scripts.reviewUpdate')}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => onOpenSettings()}>
                              {t('common.settings')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive onClick={() => void remove(script)}>
                              {t('scripts.delete')}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <Dialog open={urlOpen} onOpenChange={setUrlOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('scripts.fromUrl')}</DialogTitle>
            <DialogDescription>{t('scripts.urlPlaceholder')}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t('scripts.urlPlaceholder')}
            className="min-h-20"
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setUrlOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void installUrl()}>
              {t('common.install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
