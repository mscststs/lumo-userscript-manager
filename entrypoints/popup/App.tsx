import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CircleAlert,
  FileCode2,
  Globe,
  LayoutDashboard,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PopupScriptInfo } from '@/lib/background/scripts';
import type { RuntimeMenuCommand, RuntimeStatus, UISettings } from '@/types';
import { sendBg, onLumoEvent } from '@/lib/messages';
import { storage } from '@/store/storage';
import { cn } from '@/lib/utils';
import { ThemeInit } from '@/lib/theme';
import { FontSizeInit } from '@/lib/font-size';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/layout/EmptyState';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface PopupData {
  tabId: number;
  url?: string;
  settings: UISettings;
  runtime: RuntimeStatus;
  scripts: PopupScriptInfo[];
  total: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `https://example.com/path` → `example.com`. Falls back to the raw string. */
function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol.replace(':', '');
  } catch {
    return url;
  }
}

/**
 * Popup.
 *
 * Three fixed bands: identity + global switch, the per-page script list, and the
 * two destinations that matter (new script / dashboard). The list scrolls
 * inside a capped flex column so the footer never drifts off-screen — a popup
 * whose primary action can be scrolled away is a popup that gets closed instead.
 *
 * Density is deliberate: 13px names, 11px metadata, 28px rows. Everything the
 * eye needs to answer "is this script running here, and do I want it to?" is on
 * one line; everything else is one disclosure away.
 */
export default function App() {
  const { t } = useTranslation();
  const [data, setData] = useState<PopupData | null>(null);
  const [menus, setMenus] = useState<RuntimeMenuCommand[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setInitialLoading(true);
    setError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error(t('popup.unknownPage'));
      const next = await sendBg<PopupData>('popup:getData', {
        tabId: tab.id,
        url: tab.url,
      });
      const nextMenus =
        tab.id === undefined ? [] : await sendBg<RuntimeMenuCommand[]>('menus:list', { tabId: tab.id });
      setData(next);
      setMenus(nextMenus);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (!silent) setInitialLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      onLumoEvent((event) => {
        if (event === 'scripts-changed' || event === 'menus-changed') void load(true);
      }),
    [load],
  );

  const commandsByUuid = useMemo(() => {
    const map = new Map<string, RuntimeMenuCommand[]>();
    for (const command of menus) {
      const list = map.get(command.uuid) ?? [];
      list.push(command);
      map.set(command.uuid, list);
    }
    return map;
  }, [menus]);

  const scriptsEnabled = data?.settings.scriptsEnabled ?? true;
  const hostname = hostnameOf(data?.url);

  const scripts = useMemo(() => {
    const list = data?.scripts ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (script) =>
        script.name.toLowerCase().includes(needle) ||
        (script.namespace ?? '').toLowerCase().includes(needle),
    );
  }, [data?.scripts, query]);

  const openOptions = (hash = '') => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${hash}`) });
  };

  const openExtensions = () => {
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  };

  const toggleGlobal = async (enabled: boolean) => {
    if (!data) return;
    const previous = data;
    const nextSettings = { ...data.settings, scriptsEnabled: enabled };
    setData({ ...data, settings: nextSettings });
    setError(null);

    try {
      await storage.setUISettings(nextSettings);
    } catch (e) {
      setData(previous);
      setError(errorMessage(e));
      return;
    }

    try {
      await sendBg('runtime:refresh');
    } catch (e) {
      // The preference is persisted; keep the optimistic state and let the
      // user retry from the reload hint or the dashboard.
      setError(errorMessage(e));
    }
  };

  const toggleScript = async (script: PopupScriptInfo, enabled: boolean) => {
    if (!data) return;
    const previous = data;
    setData({
      ...data,
      scripts: data.scripts.map((item) =>
        item.uuid === script.uuid ? { ...item, enabled } : item,
      ),
    });
    setError(null);
    try {
      await sendBg('scripts:toggle', { uuid: script.uuid, enabled });
    } catch (e) {
      setData(previous);
      setError(errorMessage(e));
    }
  };

  const invokeMenu = async (command: RuntimeMenuCommand) => {
    try {
      const delivered = await sendBg<boolean>('menus:invoke', {
        tabId: command.tabId,
        frameId: command.frameId,
        uuid: command.uuid,
        id: command.id,
      });
      if (!delivered) throw new Error(t('popup.commandUnavailable'));
      window.close();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex max-h-[600px] w-[360px] flex-col bg-background text-foreground">
        <ThemeInit />
        <FontSizeInit />

        {/* ── Global band ───────────────────────────────────────────────────
            This switch pauses injection on *every* site, so it lives in the
            extension-identity band and is labelled as such. The page identity
            is a separate, read-only strip below: mixing the two scopes is how
            the popup previously implied the switch only affected this tab. */}
        <header className="flex shrink-0 items-center gap-2.5 border-b border-border bg-muted/30 px-3 py-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-primary/10 text-primary">
            <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="min-w-0 truncate text-sm font-semibold leading-tight text-foreground">
              {t('popup.injection')}
            </p>
            <p
              className={cn(
                'min-w-0 truncate text-2xs leading-tight',
                scriptsEnabled ? 'text-muted-foreground' : 'text-warning',
              )}
            >
              {scriptsEnabled ? t('common.enabled') : t('popup.globalDisabled')}
            </p>
          </div>
          <Switch
            size="sm"
            checked={scriptsEnabled}
            disabled={!data}
            onCheckedChange={(checked) => void toggleGlobal(checked)}
            aria-label={t('popup.globalSwitch')}
          />
        </header>

        {/* ── Page band ─────────────────────────────────────────────────────
            Read-only context: which tab the list below belongs to. */}
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5">
          <Globe className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span
            className="min-w-0 truncate text-xs font-medium text-foreground"
            title={data?.url}
          >
            {hostname ?? t('popup.unknownPage')}
          </span>
          {data && (
            <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground">
              {t('popup.pageSummary', { count: data.scripts.length })}
            </span>
          )}
        </div>

        {data && !data.runtime.userScriptsAvailable && (
          <div className="flex shrink-0 items-start gap-2 border-b border-border bg-destructive/5 px-3 py-2">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-2xs font-medium text-destructive">
                {t('popup.userScriptsUnavailable')}
              </p>
              <p className="mt-0.5 line-clamp-2 text-2xs leading-snug text-muted-foreground">
                {t('popup.userScriptsUnavailableDescription')}
              </p>
            </div>
            <Button
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={openExtensions}
            >
              {t('popup.openExtensions')}
            </Button>
          </div>
        )}

        {error && data && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-destructive/5 px-3 py-1.5">
            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 truncate text-2xs text-destructive" title={error}>
              {error}
            </span>
            <Button
              variant="ghost"
              size="iconSm"
              className="shrink-0"
              onClick={() => void load(true)}
              aria-label={t('common.retry')}
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
        )}

        {/* Search is progressive disclosure: five rows do not need a filter,
            fifty do. Below the threshold the field does not exist at all. */}
        {(data?.scripts.length ?? 0) > 5 && (
          <div className="shrink-0 border-b border-border px-3 py-1.5">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('popup.searchPlaceholder')}
              aria-label={t('popup.searchPlaceholder')}
              className="h-7 text-xs"
            />
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-y-auto scrollbar-lumo">
          {!data && initialLoading ? (
            <PopupSkeleton />
          ) : !data && error ? (
            <PopupError message={error} onRetry={() => void load()} />
          ) : data && data.scripts.length === 0 ? (
            <EmptyState
              icon={FileCode2}
              title={t('popup.noScripts')}
              description={t('popup.noScriptsDescription')}
              className="py-8"
            />
          ) : data && scripts.length === 0 ? (
            <EmptyState
              icon={FileCode2}
              title={t('scripts.noMatches')}
              className="py-8"
            />
          ) : data ? (
            <div className="divide-y divide-border" role="list">
              {scripts.map((script) => (
                <ScriptRow
                  key={script.uuid}
                  script={script}
                  commands={
                    script.enabled && scriptsEnabled ? commandsByUuid.get(script.uuid) ?? [] : []
                  }
                  onToggle={(enabled) => void toggleScript(script, enabled)}
                  onInvoke={(command) => void invokeMenu(command)}
                  onEdit={() => openOptions(`#/script/${script.uuid}`)}
                  onConfigure={() => openOptions(`#/script/${script.uuid}/metadata`)}
                />
              ))}
            </div>
          ) : null}
        </main>

        {/* Compact destinations with labels. The previous icon-only pair was
            unreadable without hovering, and the full-width primary made "new"
            look like the only thing worth clicking in the whole panel. */}
        <footer className="flex shrink-0 items-center gap-1 border-t border-border px-2 py-2">
          <Button size="sm" onClick={() => openOptions('#/script/new')}>
            <Plus className="h-3.5 w-3.5" />
            {t('scripts.new')}
          </Button>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => openOptions('#/scripts')}
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            {t('popup.manageShort')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => openOptions('#/settings/general')}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {t('common.settings')}
          </Button>
        </footer>
      </div>
    </TooltipProvider>
  );
}

interface ScriptRowProps {
  script: PopupScriptInfo;
  commands: RuntimeMenuCommand[];
  onToggle: (enabled: boolean) => void;
  onInvoke: (command: RuntimeMenuCommand) => void;
  onEdit: () => void;
  onConfigure: () => void;
}

function ScriptRow({
  script,
  commands,
  onToggle,
  onInvoke,
  onEdit,
  onConfigure,
}: ScriptRowProps) {
  const { t } = useTranslation();
  const title = script.version ? `${script.name} · v${script.version}` : script.name;
  // One grant is worth naming; a list of four is noise in a 360px row.
  const grants = script.grant.filter((grant) => grant && grant !== 'none');
  const grantHint =
    grants.length === 0
      ? t('install.noPermissions')
      : grants.length === 1
        ? grants[0]!
        : t('popup.grantCount', { count: grants.length });

  return (
    <div className="group px-3 py-2 transition-colors hover:bg-muted/40" role="listitem">
      <div className="flex items-start gap-2">
        <div className="mt-1 shrink-0">
          <Switch
            size="sm"
            checked={script.enabled}
            onCheckedChange={onToggle}
            aria-label={`${t('scripts.toggle')}: ${script.name}`}
          />
        </div>

        <div className="min-w-0 flex-1">
          <button type="button" onClick={onEdit} className="block w-full min-w-0 text-left">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'min-w-0 truncate text-sm font-medium leading-tight',
                  script.enabled ? 'text-foreground' : 'text-muted-foreground',
                )}
                title={title}
              >
                {script.name}
              </span>
              {script.version && <Badge variant="outline">v{script.version}</Badge>}
              {script.lastError && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      role="img"
                      aria-label={t('popup.scriptError')}
                      className="shrink-0 text-destructive"
                    >
                      <CircleAlert className="h-3.5 w-3.5" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    className="max-w-[260px] whitespace-pre-wrap break-words text-2xs"
                  >
                    {script.lastError}
                  </TooltipContent>
                </Tooltip>
              )}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-2xs leading-tight text-muted-foreground">
              <span className="truncate">{script.namespace || t('scripts.noSource')}</span>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate font-mono">{grantHint}</span>
            </span>
          </button>

          {commands.length > 0 && (
            <div className="mt-1 space-y-0.5 border-l-2 border-border pl-2">
              {commands.map((command) => (
                <button
                  key={command.id}
                  type="button"
                  className="block w-full truncate rounded px-1 py-0.5 text-left text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={() => onInvoke(command)}
                  title={command.title}
                >
                  {command.title}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="iconSm"
                aria-label={t('popup.moreActions')}
                className="opacity-70 group-hover:opacity-100 data-[state=open]:bg-accent"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[9rem]">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil />
                {t('scripts.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onConfigure}>
                <SlidersHorizontal />
                {t('popup.configure')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

function PopupSkeleton() {
  return (
    <div className="divide-y divide-border">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-start gap-2 px-3 py-2">
          <Skeleton className="mt-1 h-4 w-7 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
          <Skeleton className="h-6 w-11" />
        </div>
      ))}
    </div>
  );
}

function PopupError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <CircleAlert className="h-5 w-5 text-destructive" />
      <p className="max-w-full break-words text-xs text-destructive">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
        {t('common.retry')}
      </Button>
    </div>
  );
}
