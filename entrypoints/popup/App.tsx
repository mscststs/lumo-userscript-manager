import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  CircleAlert,
  FileCode2,
  LayoutDashboard,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  SlidersHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PopupScriptInfo } from '@/lib/background/scripts';
import type { RuntimeMenuCommand, RuntimeStatus, UISettings } from '@/types';
import { sendBg, onLumoEvent } from '@/lib/messages';
import { hostFromUrl } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ThemeInit } from '@/lib/theme';
import { FontSizeInit } from '@/lib/font-size';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/layout/EmptyState';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
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

export default function App() {
  const { t } = useTranslation();
  const [data, setData] = useState<PopupData | null>(null);
  const [menus, setMenus] = useState<RuntimeMenuCommand[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);

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
        tab.id === undefined
          ? []
          : await sendBg<RuntimeMenuCommand[]>('menus:list', { tabId: tab.id });
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
  const host = hostFromUrl(data?.url);

  const openOptions = (hash = '') => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${hash}`) });
  };

  const openExtensions = () => {
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
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
    setNeedsReload(true);
    setError(null);
    try {
      await sendBg('scripts:toggle', { uuid: script.uuid, enabled });
    } catch (e) {
      setData(previous);
      setNeedsReload(false);
      setError(errorMessage(e));
    }
  };

  const runScript = async (script: PopupScriptInfo) => {
    try {
      await sendBg('scripts:run', { uuid: script.uuid });
      window.close();
    } catch (e) {
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

  const reloadPage = async () => {
    if (!data || data.tabId < 0) return;
    try {
      await chrome.tabs.reload(data.tabId);
      window.close();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex w-[380px] flex-col bg-background">
        <ThemeInit />
        <FontSizeInit />

        <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FileCode2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-semibold text-foreground" title={data?.url}>
              {host || t('popup.unknownPage')}
            </p>
            <p className="truncate text-[10px] text-muted-foreground">
              {t('popup.title')}
              {data && ` · ${t('popup.total', { count: data.scripts.length })}`}
              {data && !scriptsEnabled && (
                <span className="text-destructive"> · {t('popup.globalDisabled')}</span>
              )}
            </p>
          </div>
        </header>

        {data && !data.runtime.userScriptsAvailable && (
          <div className="flex items-start gap-2 border-b border-border bg-destructive/5 px-3 py-2">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-destructive">
                {t('popup.userScriptsUnavailable')}
              </p>
              <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                {t('popup.userScriptsUnavailableDescription')}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-[11px]"
              onClick={openExtensions}
            >
              {t('popup.openExtensions')}
            </Button>
          </div>
        )}

        {error && data && (
          <div className="flex items-center gap-2 border-b border-border bg-destructive/5 px-3 py-1.5">
            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
            <span
              className="min-w-0 flex-1 truncate text-[11px] text-destructive"
              title={error}
            >
              {error}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={() => void load(true)}
              aria-label={t('common.retry')}
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
        )}

        <main className="max-h-[26rem] overflow-y-auto scrollbar-lumo">
          {!data && initialLoading ? (
            <PopupSkeleton />
          ) : !data && error ? (
            <PopupError message={error} onRetry={() => void load()} />
          ) : data && data.scripts.length === 0 ? (
            <EmptyState
              icon={FileCode2}
              title={t('popup.noScripts')}
              description={t('popup.noScriptsDescription')}
              className="min-h-0 py-8"
            />
          ) : data ? (
            <div className="divide-y divide-border" role="list">
              {data.scripts.map((script) => (
                <ScriptRow
                  key={script.uuid}
                  script={script}
                  commands={
                    script.enabled ? (commandsByUuid.get(script.uuid) ?? []) : []
                  }
                  onToggle={(enabled) => void toggleScript(script, enabled)}
                  onRun={() => void runScript(script)}
                  onInvoke={(command) => void invokeMenu(command)}
                  onEdit={() => openOptions(`#/script/${script.uuid}`)}
                  onConfigure={() => openOptions(`#/script/${script.uuid}/metadata`)}
                />
              ))}
            </div>
          ) : null}
        </main>

        <footer className="shrink-0 border-t border-border">
          {needsReload && (
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
              <RotateCw className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
                {t('popup.reloadHint')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-1.5 text-[11px]"
                onClick={() => void reloadPage()}
              >
                {t('common.refresh')}
              </Button>
            </div>
          )}
          <div className="flex items-center gap-1.5 px-2 py-2">
            <Button
              size="sm"
              className="h-8 flex-1 text-[12px]"
              onClick={() => openOptions('#/script/new')}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('scripts.new')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 flex-1 px-2 text-[12px] text-muted-foreground"
              onClick={() => openOptions('#/scripts')}
            >
              <LayoutDashboard className="mr-1.5 h-3.5 w-3.5" />
              {t('popup.manage')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 flex-1 px-2 text-[12px] text-muted-foreground"
              onClick={() => openOptions('#/settings')}
            >
              <Settings className="mr-1.5 h-3.5 w-3.5" />
              {t('common.settings')}
            </Button>
          </div>
        </footer>
      </div>
    </TooltipProvider>
  );
}

interface ScriptRowProps {
  script: PopupScriptInfo;
  commands: RuntimeMenuCommand[];
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onInvoke: (command: RuntimeMenuCommand) => void;
  onEdit: () => void;
  onConfigure: () => void;
}

function ScriptRow({
  script,
  commands,
  onToggle,
  onRun,
  onInvoke,
  onEdit,
  onConfigure,
}: ScriptRowProps) {
  const { t } = useTranslation();
  const title = script.version ? `${script.name} · v${script.version}` : script.name;

  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5" role="listitem">
      <div className="mt-0.5 shrink-0">
        <Switch
          size="sm"
          checked={script.enabled}
          onCheckedChange={onToggle}
          aria-label={`${t('scripts.toggle')}: ${script.name}`}
        />
      </div>

      <Collapsible className="min-w-0 flex-1">
        <div className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'truncate text-[13px] font-medium leading-tight',
                  script.enabled ? 'text-foreground' : 'text-muted-foreground',
                )}
                title={title}
              >
                {script.name}
              </span>
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
                    className="max-w-[260px] whitespace-pre-wrap break-words text-[11px]"
                  >
                    {script.lastError}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {script.namespace && (
              <p className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">
                {script.namespace}
              </p>
            )}
          </div>

          <CollapsibleTrigger
            className="group -mr-1 -mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            title={t('popup.moreActions')}
          >
            <ChevronDown className="h-3.5 w-3.5 transition-transform duration-150 group-data-[state=open]:rotate-180" />
            <span className="sr-only">{t('popup.moreActions')}</span>
          </CollapsibleTrigger>
        </div>

        {commands.length > 0 && (
          <div className="mt-1.5 space-y-0.5 border-l border-border pl-2">
            {commands.map((command) => (
              <button
                key={command.id}
                type="button"
                className="block w-full truncate rounded px-1.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => onInvoke(command)}
                title={command.title}
              >
                {command.title}
              </button>
            ))}
          </div>
        )}

        <CollapsibleContent>
          <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border/70 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onEdit}
            >
              <Pencil className="h-3 w-3" />
              {t('scripts.edit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onConfigure}
            >
              <SlidersHorizontal className="h-3 w-3" />
              {t('popup.configure')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              disabled={!script.enabled}
              onClick={onRun}
            >
              <Play className="h-3 w-3" />
              {t('popup.runOnTab')}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function PopupSkeleton() {
  return (
    <div className="divide-y divide-border">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-start gap-2.5 px-3 py-2.5">
          <div className="mt-0.5 h-5 w-9 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-2/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-2.5 w-1/4 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
          <div className="h-3.5 w-3.5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
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
