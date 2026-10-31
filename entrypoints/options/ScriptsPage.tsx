import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import {
  FileCode2,
  FilePlus2,
  Link2,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { ManagerScript } from '@/types';
import { sendBg, onLumoEvent } from '@/lib/messages';
import { cn, formatBytes } from '@/lib/utils';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { mergeMetadata } from '@/lib/script/metadata';
import { ScriptIcon } from '@/components/script/ScriptIcon';
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

/**
 * One grid template for the skeleton and every row. The time column only
 * exists from `sm` up; below that the actions take its place.
 */
const ROW_GRID =
  'grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[1.75rem_minmax(0,1fr)_auto_auto]';

/**
 * Past this size rows stop animating in and out. A filter switch on a large
 * library would otherwise run hundreds of height animations at once — motion
 * that costs frames and explains nothing.
 */
const ROW_MOTION_LIMIT = 80;

interface ScriptsPageProps {
  onOpenEditor: (uuid: string) => void;
}

interface PendingAction {
  kind: 'delete' | 'purge' | 'batch-delete';
  script?: ManagerScript;
}

export function ScriptsPage({ onOpenEditor }: ScriptsPageProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [scripts, setScripts] = useState<ManagerScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showTrash, setShowTrash] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const now = useNow(60_000);

  // Skeleton on first load only. Later reloads (every toggle echoes back as
  // `scripts-changed`) keep the current rows on screen until the fresh list
  // lands, so the list never blinks to placeholders under the pointer.
  const load = useCallback(async () => {
    setError(null);
    try {
      setScripts(await sendBg<ManagerScript[]>('scripts:list', { includeRemoved: showTrash }));
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

  // Escape leaves selection mode, as in every list that has one. Dialogs own
  // their own Escape, so the selection survives cancelling a batch confirm.
  const selecting = selected.size > 0;
  const dialogOpen = urlOpen || pending !== null;
  useEffect(() => {
    if (!selecting || dialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setSelected(new Set());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialogOpen, selecting]);

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

  const toggle = async (script: ManagerScript, enabled: boolean) => {
    const previous = scripts;
    setScripts((prev) =>
      prev.map((item) =>
        item.uuid === script.uuid
          ? { ...item, enabled, ...(enabled ? { pendingReview: undefined } : {}) }
          : item,
      ),
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

  const remove = async (script: ManagerScript) => {
    try {
      await sendBg('scripts:delete', { uuid: script.uuid });
      toast({ title: t('scripts.movedToTrash'), description: script.name, variant: 'success' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const purge = async (script: ManagerScript) => {
    try {
      await sendBg('scripts:purge', { uuid: script.uuid });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const restore = async (script: ManagerScript) => {
    try {
      await sendBg('scripts:restore', { uuid: script.uuid });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const checkUpdates = async () => {
    setChecking(true);
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
      setChecking(false);
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

  const openUpdate = (script: ManagerScript) => {
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
      actions={
        <>
          <Button size="default" onClick={() => onOpenEditor('new')}>
            <FilePlus2 className="h-3.5 w-3.5" />
            {t('scripts.new')}
          </Button>
          <Button
            variant="outline"
            size="default"
            disabled={checking || loading}
            onClick={() => void checkUpdates()}
          >
            {checking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t('scripts.checkUpdates')}
            {!checking && counts.updates > 0 && (
              <span className="rounded-full bg-primary/10 px-1.5 text-2xs tabular-nums text-primary">
                {counts.updates}
              </span>
            )}
          </Button>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="default" disabled={busy}>
              <Upload className="h-3.5 w-3.5" />
              {t('scripts.import')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => setUrlOpen(true)}>
              <Link2 />
              {t('scripts.importUrl')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => fileInput.current?.click()}>
              <Upload />
              {t('scripts.importFile')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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

      <div className="mt-3 rounded-card border border-border bg-card p-1 shadow-surface">
        {loading ? (
          <div>
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className={cn(ROW_GRID, 'px-2.5 py-2')}>
                <Skeleton className="h-7 w-7 rounded-[7px]" />
                <div className="min-w-0 space-y-1.5">
                  <Skeleton className="h-3.5 w-2/5" />
                  <Skeleton className="h-2.5 w-3/5" />
                </div>
                <Skeleton className="hidden h-2.5 w-12 sm:block" />
                <Skeleton className="h-4 w-7 rounded-full" />
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
          // No column header: every cell explains itself (identity, name, time,
          // switch), and "select all" lives in the batch bar, the one place a
          // selection is acted on.
          <AnimatePresence initial={false}>
            {filtered.map((script) => (
              <motion.div
                key={script.uuid}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={
                  filtered.length > ROW_MOTION_LIMIT
                    ? { duration: 0 }
                    : { duration: 0.2, ease: [0.16, 1, 0.3, 1] }
                }
                className="overflow-hidden"
              >
                <ScriptRow
                  script={script}
                  selected={selected.has(script.uuid)}
                  selecting={selecting}
                  onSelect={() => toggleOne(script.uuid)}
                  onToggle={(enabled) => void toggle(script, enabled)}
                  onOpen={() => onOpenEditor(script.uuid)}
                  onRestore={() => void restore(script)}
                  onReviewUpdate={() => openUpdate(script)}
                  onDelete={() => setPending({ kind: 'delete', script })}
                  onPurge={() => setPending({ kind: 'purge', script })}
                  locale={i18n.language}
                  now={now}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Batch bar: appears only with a selection, and occupies the bottom edge
          where the pointer already is after dragging across rows. It carries
          the master checkbox, so selecting everything is one more click from
          the first selection rather than a header nobody else needs. */}
      <AnimatePresence>
        {selecting && (
          <motion.div
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="sticky bottom-3 z-30 mx-auto mt-3 flex w-fit max-w-full flex-wrap items-center gap-1 rounded-card border border-border bg-popover py-1 pl-1 pr-1.5 shadow-elev3"
          >
            <Checkbox
              checked={allSelected}
              indeterminate={someSelected}
              onCheckedChange={toggleAll}
              label={t('scripts.selectAll')}
            />
            <span className="pr-1.5 text-xs tabular-nums text-muted-foreground">
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
  selecting,
  onSelect,
  onToggle,
  onOpen,
  onRestore,
  onReviewUpdate,
  onDelete,
  onPurge,
  locale,
  now,
}: {
  script: ManagerScript;
  selected: boolean;
  /** Any row is selected: every row shows its checkbox, not just the hovered one. */
  selecting: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onOpen: () => void;
  onRestore: () => void;
  onReviewUpdate: () => void;
  onDelete: () => void;
  onPurge: () => void;
  locale: string;
  now: number;
}) {
  const { t } = useTranslation();
  const removed = Boolean(script.removedAt);
  const off = removed || !script.enabled;
  const effective = mergeMetadata(script.metadata, script.selfMetadata);
  const matches = [...(effective.match ?? []), ...(effective.include ?? [])];

  return (
    <div
      className={cn(
        ROW_GRID,
        'group relative rounded-control px-2.5 py-2 transition-colors duration-100 ease-standard',
        selected ? 'bg-primary/[0.07]' : 'hover:bg-accent/60',
      )}
    >
      {/* The leading slot is the script's identity until the row is about to be
          selected: under the pointer, on keyboard focus, or while any selection
          exists, the icon hands its place to the checkbox. The checkbox comes
          first in the DOM so the icon can react to its focus (`peer`). */}
      <div className="relative h-7 w-7">
        <Checkbox
          checked={selected}
          onCheckedChange={onSelect}
          label={script.name}
          className={cn(
            'peer absolute inset-0 z-10 transition-opacity duration-100 ease-standard',
            selecting ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
          )}
        />
        <ScriptIcon
          src={script.iconUrl}
          size="md"
          dimmed={off}
          className={cn(
            'transition-opacity duration-100 ease-standard',
            selecting ? 'opacity-0' : 'group-hover:opacity-0 peer-focus-visible:opacity-0',
          )}
        />
      </div>

      <button
        type="button"
        onClick={onOpen}
        disabled={removed}
        className="min-w-0 rounded-sm text-left disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'min-w-0 truncate text-sm font-medium',
              off ? 'text-muted-foreground' : 'text-foreground',
            )}
            title={script.name}
          >
            {script.name}
          </span>
          {script.updateState === 'update-available' && (
            <Badge variant="accent">{t('scripts.updateAvailable')}</Badge>
          )}
          {removed && <Badge variant="default">{t('scripts.trash')}</Badge>}
          {!removed && script.pendingReview && (
            <Badge variant="warning">{t('scripts.pendingReview')}</Badge>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          {script.version && (
            <>
              <span className="shrink-0 tabular-nums">v{script.version}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="min-w-0 truncate">{script.namespace || t('scripts.noSource')}</span>
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
        className="hidden whitespace-nowrap text-right text-2xs tabular-nums text-muted-foreground sm:block"
        title={t('scripts.updatedAt', { time: formatDateTime(script.updatedAt, locale) })}
      >
        {formatRelativeTime(script.updatedAt, locale, now)}
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
        {/* Row actions surface with the row: under the pointer, on focus, and
            for as long as their menu is open. Without a hovering pointer
            (touch) there is nothing to surface them, so they stay visible. */}
        <div className="opacity-0 transition-opacity duration-100 ease-standard focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="iconSm" aria-label={t('common.actions')}>
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
    </div>
  );
}
