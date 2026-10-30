import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CircleAlert,
  FileCode2,
  LayoutDashboard,
  Plus,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  ShieldOff,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PopupScriptInfo } from '@/lib/background/scripts';
import type { PageAccess } from '@/lib/page-access';
import type { RuntimeMenuCommand, RuntimeStatus, UISettings } from '@/types';
import { sendBg, onLumoEvent } from '@/lib/messages';
import { storage } from '@/store/storage';
import { cn } from '@/lib/utils';
import { ThemeInit } from '@/lib/theme';
import { FontSizeInit } from '@/lib/font-size';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface PopupData {
  tabId: number;
  url?: string;
  access: PageAccess;
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

/** Single glyph used as the row's identity tile until scripts ship real icons. */
function monogramOf(name: string): string {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : '•';
}

/**
 * Popup.
 *
 * Modelled on the browser's own extension panel rather than on a web app: one
 * flat list of 40px rows, one line of text per row, actions pinned to the row's
 * trailing edge, hover as the only chrome. Rows are *destinations* — clicking
 * anywhere on a row opens that script — and the trailing glyph is the only
 * other target, so a 300px row never hides a second, different action.
 *
 * Attribution (version, namespace, grants) is deliberately not on screen: it is
 * identical for every row's owner and only interesting once you are inside the
 * editor. It stays reachable through the row's `title`.
 *
 * Only two things are always visible below the list: the master injection
 * switch (a global preference, so it is a settings row, not a script row) and
 * the way out to the full manager. New-script lives in the header as a single
 * trailing glyph — the popup is for *this page*, not for authoring.
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
  // On privileged pages the hostname reads like a site (`chrome://extensions`
  // → "extensions"), so the scheme is the honest scope label there.
  const scopeLabel = data
    ? data.access.injectable
      ? hostnameOf(data.url)
      : data.access.label ?? hostnameOf(data.url)
    : null;

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
    <TooltipProvider delayDuration={400}>
      <div className="flex max-h-[600px] w-[360px] flex-col bg-background p-2 text-foreground">
        <ThemeInit />
        <FontSizeInit />

        {data && !data.runtime.userScriptsAvailable && (
          <div className="mb-1 flex items-center gap-2 rounded-md bg-destructive/8 px-2 py-1.5">
            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-2xs text-destructive" title={t('popup.userScriptsUnavailableDescription')}>
              {t('popup.userScriptsUnavailable')}
            </span>
            <button
              type="button"
              onClick={openExtensions}
              className="shrink-0 rounded px-1 text-2xs font-medium text-destructive underline-offset-2 hover:underline"
            >
              {t('popup.openExtensions')}
            </button>
          </div>
        )}

        {error && data && (
          <div className="mb-1 flex items-center gap-2 rounded-md bg-destructive/8 px-2 py-1.5">
            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-2xs text-destructive" title={error}>
              {error}
            </span>
            <button
              type="button"
              onClick={() => void load(true)}
              className="shrink-0 rounded p-0.5 text-destructive hover:bg-destructive/10"
              aria-label={t('common.retry')}
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Search is progressive disclosure: five rows do not need a filter,
            fifty do. Below the threshold the field does not exist at all. */}
        {(data?.scripts.length ?? 0) > 5 && (
          <div className="shrink-0 pb-1">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('popup.searchPlaceholder')}
              aria-label={t('popup.searchPlaceholder')}
              className="h-8 rounded-full bg-muted text-xs"
            />
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-y-auto scrollbar-lumo">
          {data && (
            /* Scope label, exactly like the browser's own popup: what the rows
               below belong to, stated once, in one line. The trailing glyph is
               the one create action — the list header is where a list action
               belongs, and it costs no vertical band of its own. */
            <div className="flex items-center gap-2 px-2 pb-1 pt-1">
              <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="min-w-0 truncate font-medium" title={data.url}>
                  {scopeLabel ?? t('popup.unknownPage')}
                </span>
                {data.access.injectable && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="shrink-0 tabular-nums">
                      {t('popup.pageSummary', { count: data.scripts.length })}
                    </span>
                  </>
                )}
              </p>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => openOptions('#/script/new')}
                    aria-label={t('scripts.new')}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 ease-standard hover:bg-foreground/10 hover:text-foreground"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('scripts.new')}</TooltipContent>
              </Tooltip>
            </div>
          )}
          {!data && initialLoading ? (
            <PopupSkeleton />
          ) : !data && error ? (
            <PopupError message={error} onRetry={() => void load()} />
          ) : data && !data.access.injectable ? (
            <PopupEmpty title={t('popup.noPageAccess')} icon={ShieldOff} />
          ) : data && data.scripts.length === 0 ? (
            <PopupEmpty title={t('popup.noScripts')} />
          ) : data && scripts.length === 0 ? (
            <PopupEmpty title={t('scripts.noMatches')} />
          ) : data ? (
            <div className="pb-1" role="list" aria-label={scopeLabel ?? t('popup.unknownPage')}>
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
                />
              ))}
            </div>
          ) : null}
        </main>

        {/* Global scopes, as rows of the same list rather than a second bar of
            buttons: a preference and a destination, both one click deep. */}
        <div className="mt-1 shrink-0 border-t border-border pt-1">
          <button
            type="button"
            aria-pressed={scriptsEnabled}
            aria-label={t('popup.injection')}
            disabled={!data}
            onClick={() => void toggleGlobal(!scriptsEnabled)}
            className="flex h-10 w-full items-center gap-2.5 rounded-control pl-2 pr-1 text-left transition-colors duration-150 ease-standard hover:bg-accent active:bg-accent/70 disabled:cursor-not-allowed"
          >
            <StateGlyph
              on={scriptsEnabled}
              className={scriptsEnabled ? 'text-primary' : 'text-muted-foreground'}
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-sm transition-colors duration-150 ease-standard',
                scriptsEnabled ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {t('popup.injection')}
            </span>
          </button>
          <button
            type="button"
            onClick={() => openOptions('#/scripts')}
            className="flex h-10 w-full items-center gap-2.5 rounded-control pl-2 pr-1 text-left transition-colors duration-150 ease-standard hover:bg-accent active:bg-accent/70"
          >
            <LayoutDashboard
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {t('popup.manage')}
            </span>
          </button>
        </div>
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
}

/**
 * One script on the current page: identity on the left, the only non-navigating
 * action on the right. Everything else about the script is one click away
 * inside the editor, so the row stays a single line tall.
 */
function ScriptRow({ script, commands, onToggle, onInvoke, onEdit }: ScriptRowProps) {
  const { t } = useTranslation();
  const label = script.version ? `${script.name} · v${script.version}` : script.name;
  const toggleLabel = script.enabled ? t('popup.disableScript') : t('popup.enableScript');

  return (
    <div role="listitem">
      <div className="flex h-10 items-center rounded-control pl-2 pr-1 transition-colors duration-150 ease-standard hover:bg-accent focus-within:bg-accent">
        {/* The row is the switch. Its hit area is the full row minus the edit
            button, so enabling and disabling never requires hitting a widget —
            the state is read at a glance from the glyph and the ink. */}
        <button
          type="button"
          onClick={() => onToggle(!script.enabled)}
          aria-pressed={script.enabled}
          aria-label={`${toggleLabel}: ${script.name}`}
          title={label}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <StateGlyph on={script.enabled} className={script.enabled ? 'text-primary' : 'text-muted-foreground'} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm transition-colors duration-150 ease-standard',
              script.enabled ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {script.name}
          </span>
          {script.lastError && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  aria-label={t('popup.scriptError')}
                  className="shrink-0 text-destructive"
                >
                  <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />
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
        </button>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onEdit}
              aria-label={`${t('scripts.edit')}: ${script.name}`}
              className="relative z-10 mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 ease-standard hover:bg-foreground/10 hover:text-foreground"
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('scripts.edit')}</TooltipContent>
        </Tooltip>
      </div>

      {commands.length > 0 && (
        <div className="ml-8.5 border-l border-border pl-1.5 pr-1">
          {commands.map((command) => (
            <button
              key={command.id}
              type="button"
              onClick={() => onInvoke(command)}
              title={command.title}
              className="flex h-8 w-full items-center truncate rounded-md px-2 text-left text-xs text-muted-foreground transition-colors duration-150 ease-standard hover:bg-accent hover:text-foreground"
            >
              <span className="min-w-0 truncate">{command.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * On/off state as a glyph: a power symbol that gains its slash and drops out of
 * the accent colour when the thing it belongs to is off. Two stacked glyphs
 * crossfade, so the change reads as a shape shift rather than a flicker.
 */
function StateGlyph({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'relative flex h-4 w-4 shrink-0 items-center justify-center transition-colors duration-150 ease-standard',
        className,
      )}
      aria-hidden="true"
    >
      <Power
        className={cn(
          'absolute h-4 w-4 transition-opacity duration-150 ease-standard',
          on ? 'opacity-100' : 'opacity-0',
        )}
      />
      <PowerOff
        className={cn(
          'absolute h-4 w-4 transition-opacity duration-150 ease-standard',
          on ? 'opacity-0' : 'opacity-100',
        )}
      />
    </span>
  );
}

function PopupSkeleton() {
  // Same geometry as a row (40px, 20px tile, 28px trailing action) so the first
  // paint does not jump when data lands.
  return (
    <div className="pb-1 pt-2">
      <Skeleton className="mx-3 mb-2 h-2.5 w-24" />
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex h-10 items-center gap-2.5 rounded-control px-2">
          <Skeleton className="h-5 w-5 rounded-[5px]" />
          <Skeleton className={cn('h-3 flex-1', index === 0 ? 'max-w-[58%]' : index === 1 ? 'max-w-[46%]' : 'max-w-[34%]')} />
          <Skeleton className="h-4 w-4 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function PopupEmpty({ title, icon: Icon = FileCode2 }: { title: string; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <Icon className="h-4.5 w-4.5 text-muted-foreground/60" aria-hidden="true" />
      <p className="text-xs text-muted-foreground">{title}</p>
    </div>
  );
}

function PopupError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <CircleAlert className="h-4.5 w-4.5 text-destructive" aria-hidden="true" />
      <p className="max-w-full break-words text-xs text-destructive">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors duration-150 ease-standard hover:bg-accent hover:text-foreground"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        {t('common.retry')}
      </button>
    </div>
  );
}
