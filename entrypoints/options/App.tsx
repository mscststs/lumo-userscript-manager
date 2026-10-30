import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode2, Info, ScrollText, Settings } from 'lucide-react';
import { ThemeInit } from '@/lib/theme';
import { FontSizeInit } from '@/lib/font-size';
import { ScriptsPage } from './ScriptsPage';
import { EditorPage } from './EditorPage';
import { SettingsPage } from './SettingsPage';
import { LogsPage } from './LogsPage';
import { AboutPage } from './About';

type RouteName = 'scripts' | 'editor' | 'settings' | 'logs' | 'about';

interface Route {
  name: RouteName;
  uuid?: string;
}

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [name, id] = hash.split('/');
  if (name === 'script') return { name: 'editor', uuid: id };
  if (name === 'settings' || name === 'logs' || name === 'about') return { name };
  return { name: 'scripts' };
}

function useHashRoute() {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((next: Route) => {
    const hash =
      next.name === 'editor'
        ? `#/script/${next.uuid ?? 'new'}`
        : next.name === 'scripts'
          ? '#/scripts'
          : `#/${next.name}`;
    window.location.hash = hash;
    setRoute(next);
  }, []);
  return { route, navigate };
}

const NAV: { name: Exclude<RouteName, 'editor'>; labelKey: string; icon: ReactNode }[] = [
  { name: 'scripts', labelKey: 'options.nav.scripts', icon: <FileCode2 className="h-4 w-4" /> },
  { name: 'logs', labelKey: 'options.nav.logs', icon: <ScrollText className="h-4 w-4" /> },
  { name: 'settings', labelKey: 'options.nav.settings', icon: <Settings className="h-4 w-4" /> },
  { name: 'about', labelKey: 'options.nav.about', icon: <Info className="h-4 w-4" /> },
];

export default function App() {
  const { t } = useTranslation();
  const { route, navigate } = useHashRoute();
  const active = route.name === 'editor' ? 'scripts' : route.name;

  return (
    <div className="flex h-screen w-full bg-background">
      <ThemeInit />
      <FontSizeInit />

      <nav className="flex w-16 shrink-0 flex-col border-r border-border bg-card md:w-56">
        <div className="flex h-14 items-center gap-2 border-b border-border px-3 md:px-4">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FileCode2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <span className="hidden min-w-0 truncate text-sm font-semibold text-foreground md:inline">
            {t('app.name')}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-lumo p-2">
          <div className="space-y-0.5">
            {NAV.map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={() => navigate({ name: item.name })}
                title={t(item.labelKey)}
                className={`flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm transition-colors md:justify-start ${
                  active === item.name
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                {item.icon}
                <span className="hidden truncate md:inline">{t(item.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="hidden border-t border-border p-3 text-[11px] text-muted-foreground md:block">
          {t('app.tagline')}
        </div>
      </nav>

      <main className="min-w-0 flex-1 overflow-auto scrollbar-lumo p-4 md:p-8">
        {route.name === 'scripts' && (
          <ScriptsPage
            onOpenEditor={(uuid) => navigate({ name: 'editor', uuid })}
            onOpenSettings={() => navigate({ name: 'settings' })}
          />
        )}
        {route.name === 'editor' && (
          <EditorPage
            uuid={route.uuid}
            onBack={() => navigate({ name: 'scripts' })}
            onSaved={(uuid) => navigate({ name: 'editor', uuid })}
          />
        )}
        {route.name === 'settings' && <SettingsPage />}
        {route.name === 'logs' && <LogsPage />}
        {route.name === 'about' && <AboutPage />}
      </main>
    </div>
  );
}
