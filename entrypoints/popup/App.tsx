import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileCode2, MoreHorizontal, Plus, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PopupScriptInfo } from '@/lib/background/scripts';
import type { RuntimeMenuCommand, RuntimeStatus, UISettings } from '@/types';
import { storage } from '@/store/storage';
import { sendBg, onLumoEvent } from '@/lib/messages';
import { hostFromUrl } from '@/lib/format';
import { ThemeInit } from '@/lib/theme';
import { FontSizeInit } from '@/lib/font-size';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/layout/EmptyState';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface PopupData {
  tabId: number;
  url?: string;
  settings: UISettings;
  runtime: RuntimeStatus;
  scripts: PopupScriptInfo[];
  total: number;
}

export default function App() {
  const { t } = useTranslation();
  const [data, setData] = useState<PopupData | null>(null);
  const [menus, setMenus] = useState<RuntimeMenuCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab.');
      const next = await sendBg<PopupData>('popup:getData', {
        tabId: tab.id,
        url: tab.url,
      });
      setData(next);
      if (tab.id !== undefined) {
        setMenus(await sendBg<RuntimeMenuCommand[]>('menus:list', { tabId: tab.id }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => onLumoEvent((event) => {
    if (event === 'scripts-changed' || event === 'menus-changed') void load();
  }), [load]);

  const toggleGlobal = async (enabled: boolean) => {
    if (!data) return;
    const next = { ...data.settings, scriptsEnabled: enabled };
    setData({ ...data, settings: next });
    try {
      await storage.setUISettings(next);
      await sendBg('runtime:refresh');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleScript = async (script: PopupScriptInfo, enabled: boolean) => {
    if (!data) return;
    setData({
      ...data,
      scripts: data.scripts.map((item) =>
        item.uuid === script.uuid ? { ...item, enabled } : item,
      ),
    });
    try {
      await sendBg('scripts:toggle', { uuid: script.uuid, enabled });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await load();
    }
  };

  const openOptions = (hash = '') => {
    void chrome.tabs.create({
      url: chrome.runtime.getURL(`options.html${hash}`),
    });
  };

  const openExtensions = () => {
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  };

  const invokeMenu = async (command: RuntimeMenuCommand) => {
    await sendBg('menus:invoke', {
      tabId: command.tabId,
      frameId: command.frameId,
      uuid: command.uuid,
      id: command.id,
    });
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return data.scripts;
    return data.scripts.filter(
      (script) =>
        script.name.toLowerCase().includes(needle) ||
        script.namespace.toLowerCase().includes(needle),
    );
  }, [data, query]);

  const host = hostFromUrl(data?.url);

  return (
    <div className="flex w-[380px] flex-col bg-background">
      <ThemeInit />
      <FontSizeInit />

      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FileCode2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{t('popup.title')}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {host || t('popup.unknownPage')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openOptions('#/script/new')}>
            <Plus className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openOptions('#/settings')}>
            <Settings2 className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {data && !data.runtime.userScriptsAvailable && (
        <div className="border-b border-border bg-destructive/5 px-3 py-2">
          <p className="text-[11px] font-medium text-destructive">{t('popup.userScriptsUnavailable')}</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
            {t('popup.userScriptsUnavailableDescription')}
          </p>
          <Button variant="outline" size="sm" className="mt-1.5 h-7 text-[11px]" onClick={openExtensions}>
            {t('popup.openExtensions')}
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {data?.settings.scriptsEnabled ? t('popup.globalEnabled') : t('popup.globalDisabled')}
          </span>
          {data && (
            <Badge variant="outline" className="text-[10px]">
              {t('popup.total', { count: data.total })}
            </Badge>
          )}
        </div>
        <Switch
          checked={data?.settings.scriptsEnabled ?? true}
          onCheckedChange={(checked) => void toggleGlobal(checked)}
          aria-label={t('popup.globalEnabled')}
        />
      </div>

      {data && data.scripts.length > 8 && (
        <div className="border-b border-border px-3 py-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('popup.searchPlaceholder')}
            className="h-8 text-xs"
          />
        </div>
      )}

      <main className="max-h-[28rem] overflow-auto scrollbar-lumo">
        {loading ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t('common.loading')}</p>
        ) : error ? (
          <p className="whitespace-pre-wrap px-3 py-6 text-center text-xs text-destructive">{error}</p>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={FileCode2}
            title={t('popup.noScripts')}
            description={t('popup.noScriptsDescription')}
            action={
              <Button variant="outline" size="sm" onClick={() => openOptions('#/scripts')}>
                {t('popup.manage')}
              </Button>
            }
          />
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((script) => {
              const commands = script.enabled
                ? menus.filter((item) => item.uuid === script.uuid)
                : [];
              return (
                <div key={script.uuid} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => openOptions(`#/script/${script.uuid}`)}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-foreground">
                          {script.name}
                        </span>
                        {script.version && (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            v{script.version}
                          </span>
                        )}

                      </div>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {script.namespace || t('scripts.noSource')}
                      </p>
                      {script.lastError && (
                        <p className="truncate text-[10px] text-destructive">{script.lastError}</p>
                      )}
                    </button>
                    <Switch
                      checked={script.enabled}
                      onCheckedChange={(checked) => void toggleScript(script, checked)}
                      aria-label={t('scripts.toggle')}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openOptions(`#/script/${script.uuid}`)}>
                          {t('scripts.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openOptions('#/scripts')}>
                          {t('common.settings')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {commands.length > 0 && (
                    <div className="mt-1 space-y-0.5 border-l border-border pl-2">
                      {commands.map((command) => (
                        <button
                          key={command.id}
                          type="button"
                          className="block w-full truncate rounded px-1.5 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                          onClick={() => void invokeMenu(command)}
                        >
                          {command.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>

      <footer className="border-t border-border p-2">
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => openOptions('#/scripts')}>
          {t('popup.manage')}
        </Button>
      </footer>
    </div>
  );
}
