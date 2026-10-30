import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import {
  FileCode2,
  FilePlus2,
  Link2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { UserScript } from '@/types';
import { sendBg, onLumoEvent } from '@/lib/messages';
import { formatBytes } from '@/lib/utils';
import { formatDateTime, formatDateTimeShort } from '@/lib/format';
import { mergeMetadata } from '@/lib/script/metadata';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Segmented } from '@/components/ui/segmented';
import { EmptyState } from '@/components/layout/EmptyState';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
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

type Filter = 'all' | 'enabled' | 'disabled' | 'updates';

/** One grid template for the header *and* every row, so columns cannot drift. */
const ROW_GRID =
  'grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[1.75rem_minmax(0,1fr)_7.5rem_5rem] sm:gap-3';

interface ScriptsPageProps {
  onOpenEditor: (uuid: string) => void;
  onOpenSettings: () => void;
}

interface PendingAction {
  kind: 'delete' | 'purge' | 'batch-delete';
  script?: UserScript;
}

export function ScriptsPage({ onOpenEditor, onOpenSettings }: ScriptsPageProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showTrash, setShowTrash] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
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

  useEffect(
    () =>
      onLumoEvent((event) => {
        if (event === 'scripts-changed' || event === 'updates-checked') void load();
      }),
    [load],
  );

  // A filter change invalidates any selection made under the previous one.
  useEffect(() => {
    setSelected(new Set());
  }, [filter, showTrash, query]);


  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scripts.filter((script) => {
      if (filter === 'enabled' && (!script.enabled || script.removedAt)) return false;
      if (filter === 'disabled' && (script.enabled || script.removedAt)) return false;
      if (filter === 'updates' && script.updateState !== 'update-available') return false;
      if (!needle) return true;
      return (
        script.name.toLowerCase().includes(needle) ||
        script.namespace.toLowerCase().includes(needle) ||
        script.tags.some((tag) => tag.toLowerCase().includes(needle)) ||
        [...(script.metadata.match ?? []), ...(script.metadata.include ?? [])].some((value) =>
          value.toLowerCase().includes(needle),
        )
      );
    });
  }, [filter, query, scripts]);

  const counts = useMemo(
    () => ({
      all: scripts.length,
      enabled: scripts.filter((script) => script.enabled && !script.removedAt).length,
      disabled: scripts.filter((script) => !script.enabled || script.removedAt).length,
      updates: scripts.filter((script) => script.updateState === 'update-available').length,
    }),
    [scripts],
  );

  // "Update available" is a conditional option: once the last pending update is
  // applied it disappears from the control, so a lingering selection would point
  // at a tab that no longer exists.
  useEffect(() => {
    if (filter === 'updates' && !loading && counts.updates === 0) setFilter('all');
  }, [counts.updates, filter, loading]);

  const toggle = async (script: UserScript, enabled: boolean) => {
    const previous = scripts;
    setScripts((prev) =>
      prev.map((item) => (item.uuid === script.uuid ? { ...item, enabled } : item)),
    );
    try {
      await sendBg('scripts:toggle', { uuid: script.uuid, enabled });
    } catch (e) {
      setScripts(previous);
      toast({
        title: t('common.error'),
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      });
    }
  };

  const remove = async (script: UserScript) => {
    try {
      await sendBg('scripts:delete', { uuid: script.uuid });
      toast({ title: t('scripts.movedToTrash'), description: script.name, variant: 'success' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const purge = async (script: UserScript) => {
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
    setBusy(true);
    try {
      const result = await sendBg<{
        checked: number;
        updated: number;
        available: number;
        errors: string[];
      }>('updates:check');
      toast({
        title: t('scripts.checkUpdatesDone', result),
        description: result.errors?.length ? result.errors.join('\n') : undefined,
        variant: result.errors?.length ? 'error' : 'success',
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Scripts page owns the *script* lifecycle: a dropped file is a userscript to
  // review and install. Backups are a different scope and live in
  // Settings → Data, so a `.json`/`.zip` here no longer silently restores one.
  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const code = await file.text();
        const { token } = await sendBg<{ token: string }>('install:prepare', { code });
        await chrome.tabs.create({
          url: `${chrome.runtime.getURL('install.html')}?token=${token}`,
        });
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const installUrl = async () => {
    if (!url.trim()) {
      setError(t('scripts.urlRequired'));
      return;
    }
    setBusy(true);
    try {
      const { token } = await sendBg<{ token: string }>('install:prepare', {
        sourceUrl: url.trim(),
      });
      setUrlOpen(false);
      setUrl('');
      await chrome.tabs.create({
        url: `${chrome.runtime.getURL('install.html')}?token=${token}`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openUpdate = (script: UserScript) => {
    if (!script.pendingInstallToken) return;
    void chrome.tabs.create({
      url: `${chrome.runtime.getURL('install.html')}?token=${script.pendingInstallToken}`,
    });
  };

  const allSelected = filtered.length > 0 && selected.size === filtered.length;
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(filtered.map((script) => script.uuid)));
  };

  const toggleOne = (uuid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  };

  const batch = async (action: 'enable' | 'disable' | 'delete') => {
    setBusy(true);
    try {
      for (const uuid of selected) {
        if (action === 'delete') await sendBg('scripts:delete', { uuid });
        else await sendBg('scripts:toggle', { uuid, enabled: action === 'enable' });
      }
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = async () => {
    if (!pending) return;
    if (pending.kind === 'batch-delete') await batch('delete');
    else if (pending.kind === 'delete' && pending.script) await remove(pending.script);
    else if (pending.kind === 'purge' && pending.script) await purge(pending.script);
  };

  const header = (
    <PageHeader
      title={t('scripts.title')}
      description={t('scripts.description')}
      actions={
        <>
          <Button size="default" onClick={() => onOpenEditor('new')}>
            <FilePlus2 className="h-3.5 w-3.5" />
            {t('scripts.new')}
          </Button>
          <Button variant="outline" size="default" onClick={() => setUrlOpen(true)}>
            <Link2 className="h-3.5 w-3.5" />
            {t('scripts.importUrl')}
          </Button>
          <Button variant="outline" size="default" onClick={() => fileInput.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            {t('scripts.import')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t('common.actions')}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem disabled={busy} onClick={() => void checkUpdates()}>
                <RefreshCw />
                {t('scripts.checkUpdates')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onOpenSettings}>
                {t('common.settings')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    />
  );

  return (
    <PageLayout header={header}>
      <input
        ref={fileInput}
        type="file"
        accept=".user.js,.js"
        multiple
        className="hidden"
        onChange={(event) => void importFiles(event.target.files)}
      />

      {/* Toolbar: search grows, filter stays compact, trash is a toggle. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('scripts.searchPlaceholder')}
            aria-label={t('scripts.searchPlaceholder')}
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
          ariaLabel={t('scripts.filter')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('scripts.filterAll'), count: counts.all },
            { value: 'enabled', label: t('common.enabled'), count: counts.enabled },
            { value: 'disabled', label: t('common.disabled'), count: counts.disabled },
            ...(counts.updates
              ? [{ value: 'updates' as const, label: t('scripts.updateAvailable'), count: counts.updates }]
              : []),
          ]}
        />
        <Button
          variant={showTrash ? 'secondary' : 'ghost'}
          size="default"
          onClick={() => setShowTrash((value) => !value)}
          aria-pressed={showTrash}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('scripts.trash')}
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-card border border-destructive/30 bg-destructive/5 px-3 py-2"
        >
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive">
            {error}
          </p>
          <Button variant="ghost" size="xs" onClick={() => setError(null)}>
            {t('common.close')}
          </Button>
        </div>
      )}

      <div className="mt-3 overflow-hidden rounded-card border border-border bg-card">
        {loading ? (
          <div>
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className={`${ROW_GRID} border-b border-border px-3 py-3 last:border-b-0`}>
                <Skeleton className="h-4 w-4" />
                <div className="min-w-0 space-y-1.5">
                  <Skeleton className="h-3.5 w-2/5" />
                  <Skeleton className="h-2.5 w-3/5" />
                </div>
                <Skeleton className="h-4 w-8" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={showTrash ? Trash2 : FileCode2}
            title={
              query
                ? t('scripts.noMatches')
                : showTrash
                  ? t('scripts.emptyTrashTitle')
                  : t('scripts.emptyTitle')
            }
            description={
              query
                ? undefined
                : showTrash
                  ? t('scripts.emptyTrashDescription')
                  : t('scripts.emptyDescription')
            }
            action={
              !showTrash && !query ? (
                <Button size="sm" onClick={() => onOpenEditor('new')}>
                  <FilePlus2 className="h-3.5 w-3.5" />
                  {t('scripts.new')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div
              className={`${ROW_GRID} border-b border-border px-3 py-1.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground`}
            >
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                onCheckedChange={toggleAll}
                label={t('scripts.selectAll')}
              />
              <span className="min-w-0 truncate">{t('common.name')}</span>
              <span className="hidden text-right sm:block">{t('scripts.lastUpdated')}</span>
              <span className="hidden text-right sm:block">{t('common.actions')}</span>
            </div>

            <div>
              {filtered.map((script) => (
                <ScriptRow
                  key={script.uuid}
                  script={script}
                  selected={selected.has(script.uuid)}
                  onSelect={() => toggleOne(script.uuid)}
                  onToggle={(enabled) => void toggle(script, enabled)}
                  onOpen={() => onOpenEditor(script.uuid)}
                  onRestore={() => void restore(script)}
                  onReviewUpdate={() => openUpdate(script)}
                  onDelete={() => setPending({ kind: 'delete', script })}
                  onPurge={() => setPending({ kind: 'purge', script })}
                  locale={i18n.language}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Batch bar: appears only with a selection, and occupies the bottom edge
          where the pointer already is after dragging across rows. */}
      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="sticky bottom-3 z-30 mx-auto mt-3 flex w-fit max-w-full flex-wrap items-center gap-1.5 rounded-card border border-border bg-popover px-2 py-1.5 shadow-elev3"
          >
            <span className="px-1.5 text-xs tabular-nums text-muted-foreground">
              {t('scripts.selected', { count: selected.size })}
            </span>
            <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void batch('enable')}>
              {t('scripts.batchEnable')}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void batch('disable')}>
              {t('scripts.batchDisable')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setPending({ kind: 'batch-delete' })}
            >
              {t('scripts.batchDelete')}
            </Button>
            <Button variant="ghost" size="iconSm" onClick={() => setSelected(new Set())} aria-label={t('scripts.clearSelection')}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <Dialog open={urlOpen} onOpenChange={setUrlOpen}>
        <DialogContent className="sm:max-w-md" closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('scripts.fromUrl')}</DialogTitle>
            <DialogDescription>{t('scripts.urlPlaceholder')}</DialogDescription>
          </DialogHeader>
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t('scripts.urlPlaceholder')}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') void installUrl();
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUrlOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void installUrl()} disabled={busy}>
              {t('common.install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={
          pending?.kind === 'purge'
            ? t('scripts.confirmPurge')
            : pending?.kind === 'batch-delete'
              ? t('scripts.confirmBatchDelete', { count: selected.size })
              : t('scripts.confirmDelete')
        }
        description={
          pending?.kind === 'purge'
            ? t('scripts.purgeHint')
            : pending?.kind === 'delete'
              ? t('scripts.trashHint')
              : undefined
        }
        confirmLabel={
          pending?.kind === 'purge' || pending?.kind === 'batch-delete'
            ? t('common.delete')
            : t('scripts.delete')
        }
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={confirmPending}
      />
    </PageLayout>
  );
}

function ScriptRow({
  script,
  selected,
  onSelect,
  onToggle,
  onOpen,
  onRestore,
  onReviewUpdate,
  onDelete,
  onPurge,
  locale,
}: {
  script: UserScript;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onOpen: () => void;
  onRestore: () => void;
  onReviewUpdate: () => void;
  onDelete: () => void;
  onPurge: () => void;
  locale: string;
}) {
  const { t } = useTranslation();
  const removed = Boolean(script.removedAt);
  const effective = mergeMetadata(script.metadata, script.selfMetadata);
  const matches = [...(effective.match ?? []), ...(effective.include ?? [])];

  return (
    <div
      className={`${ROW_GRID} group relative border-b border-border px-3 py-2.5 transition-colors duration-100 last:border-b-0 hover:bg-muted/40 ${
        selected ? 'bg-primary/[0.06]' : ''
      }`}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={onSelect}
        label={script.name}
        className="relative z-10"
      />

      <button
        type="button"
        onClick={onOpen}
        disabled={removed}
        className="min-w-0 text-left disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={`min-w-0 truncate text-sm font-medium ${
              removed || !script.enabled ? 'text-muted-foreground' : 'text-foreground'
            }`}
            title={script.name}
          >
            {script.name}
          </span>
          {script.version && <Badge variant="outline">v{script.version}</Badge>}
          {script.updateState === 'update-available' && (
            <Badge variant="accent">{t('scripts.updateAvailable')}</Badge>
          )}
          {removed && <Badge variant="default">{t('scripts.trash')}</Badge>}
          {!removed && !script.enabled && <Badge variant="default">{t('common.disabled')}</Badge>}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="truncate">{script.namespace || t('scripts.noSource')}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">{formatBytes(script.codeSize)}</span>
          <span aria-hidden="true" className="hidden sm:inline">
            ·
          </span>
          <span className="hidden min-w-0 truncate font-mono sm:inline">
            {matches.slice(0, 2).join(', ') || t('install.allPages')}
          </span>
        </span>
        {script.lastError && (
          <span className="mt-0.5 block truncate text-2xs text-destructive">
            {script.lastError}
          </span>
        )}
      </button>

      <span
        className="hidden truncate text-right text-2xs tabular-nums text-muted-foreground sm:block"
        title={formatDateTime(script.updatedAt, locale)}
      >
        {formatDateTimeShort(script.updatedAt, locale)}
      </span>

      <div className="flex items-center justify-end gap-1">
        {!removed && (
          <Switch
            size="sm"
            checked={script.enabled}
            onCheckedChange={onToggle}
            aria-label={`${t('scripts.toggle')}: ${script.name}`}
          />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="iconSm"
              aria-label={t('common.actions')}
              className="opacity-60 group-hover:opacity-100"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {removed ? (
              <>
                <DropdownMenuItem onClick={onRestore}>
                  <RotateCcw />
                  {t('scripts.restore')}
                </DropdownMenuItem>
                <DropdownMenuItem destructive onClick={onPurge}>
                  <Trash2 />
                  {t('scripts.purge')}
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem onClick={onOpen}>{t('scripts.edit')}</DropdownMenuItem>
                {script.updateState === 'update-available' && script.pendingInstallToken && (
                  <DropdownMenuItem onClick={onReviewUpdate}>
                    {t('scripts.reviewUpdate')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onClick={onDelete}>
                  <Trash2 />
                  {t('scripts.delete')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
