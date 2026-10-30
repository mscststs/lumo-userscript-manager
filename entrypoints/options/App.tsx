import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { motion, MotionConfig } from 'motion/react';
import {
  FileCode2,
  Info,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
} from 'lucide-react';
import { ThemeInit } from '@/lib/theme';
import { FontSizeInit } from '@/lib/font-size';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { ToastProvider } from '@/components/ui/toast';
import { ScriptsPage } from './ScriptsPage';
import { EditorPage } from './EditorPage';
import { SettingsPage } from './SettingsPage';
import { LogsPage } from './LogsPage';
import { AboutPage } from './About';
import { AppearancePage } from './AppearancePage';

type RouteName = 'scripts' | 'editor' | 'settings' | 'appearance' | 'logs' | 'about';
type SettingsSection = 'general' | 'updates' | 'data';

interface Route {
  name: RouteName;
  uuid?: string;
  /** Optional editor panel opened by a deep link from the popup. */
  panel?: string;
  section?: SettingsSection;
}

const SETTINGS_SECTIONS: SettingsSection[] = ['general', 'updates', 'data'];

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [name, id, panel] = hash.split('/');
  if (name === 'script') return { name: 'editor', uuid: id, panel };
  if (name === 'settings') {
    // Appearance used to be a settings section; keep old deep links working.
    if (id === 'appearance') return { name: 'appearance' };
    return {
      name: 'settings',
      section: SETTINGS_SECTIONS.includes(id as SettingsSection)
        ? (id as SettingsSection)
        : 'general',
    };
  }
  if (name === 'logs' || name === 'appearance' || name === 'about') return { name };
  return { name: 'scripts' };
}

function routeToHash(route: Route): string {
  if (route.name === 'editor') {
    return `#/script/${route.uuid ?? 'new'}${route.panel ? `/${route.panel}` : ''}`;
  }
  if (route.name === 'settings') return `#/settings/${route.section ?? 'general'}`;
  return `#/${route.name}`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function useHashRoute() {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    const hash = routeToHash(next);
    const commit = () => {
      window.location.hash = hash;
      setRoute(next);
    };

    // View Transitions give the content swap a physical continuity that a CSS
    // fade cannot: the old page and the new page are the *same* surface. Falls
    // through to an instant swap where the API is missing or reduced motion is
    // requested — the navigation must never wait on an animation.
    const doc = document as Document & {
      startViewTransition?: (callback: () => void) => { finished: Promise<void> };
    };
    if (doc.startViewTransition && !prefersReducedMotion()) {
      // React batches state updates, which would land after the transition has
      // already snapshotted the DOM. `flushSync` keeps the mutation inside the
      // callback, which is the documented React + View Transition pairing.
      doc.startViewTransition(() => flushSync(commit));
    } else {
      commit();
    }
  }, []);

  return { route, navigate };
}

const NAV: {
  name: Exclude<RouteName, 'editor'>;
  labelKey: string;
  icon: ReactNode;
}[] = [
  { name: 'scripts', labelKey: 'options.nav.scripts', icon: <FileCode2 className="h-4 w-4" /> },
  { name: 'logs', labelKey: 'options.nav.logs', icon: <ScrollText className="h-4 w-4" /> },
  { name: 'settings', labelKey: 'options.nav.settings', icon: <Settings className="h-4 w-4" /> },
  { name: 'appearance', labelKey: 'options.nav.appearance', icon: <Palette className="h-4 w-4" /> },
  { name: 'about', labelKey: 'options.nav.about', icon: <Info className="h-4 w-4" /> },
];

export default function App() {
  const { t } = useTranslation();
  const { route, navigate } = useHashRoute();
  const [collapsed, setCollapsed] = useState(false);
  const active = route.name === 'editor' ? 'scripts' : route.name;

  const content = useMemo(() => {
    if (route.name === 'scripts') {
      return (
        <ScriptsPage
          onOpenEditor={(uuid) => navigate({ name: 'editor', uuid })}
          onOpenSettings={() => navigate({ name: 'settings', section: 'general' })}
        />
      );
    }
    if (route.name === 'editor') {
      return (
        <EditorPage
          uuid={route.uuid}
          initialPanel={route.panel}
          onBack={() => navigate({ name: 'scripts' })}
          onSaved={(uuid) => navigate({ name: 'editor', uuid })}
        />
      );
    }
    if (route.name === 'settings') {
      return (
        <SettingsPage
          section={route.section ?? 'general'}
          onNavigate={(section) => navigate({ name: 'settings', section })}
        />
      );
    }
    if (route.name === 'logs') return <LogsPage />;
    if (route.name === 'appearance') return <AppearancePage />;
    return <AboutPage onOpenData={() => navigate({ name: 'settings', section: 'data' })} />;
  }, [navigate, route]);

  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delayDuration={400}>
        <ToastProvider>
          <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
            <ThemeInit />
            <FontSizeInit />

            <nav
              className={cn(
                'flex h-full shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 ease-standard',
                collapsed ? 'w-14' : 'w-14 md:w-56',
              )}
            >
              <div
                className={cn(
                  'flex h-14 shrink-0 items-center gap-2.5 px-3',
                  !collapsed && 'md:px-4',
                )}
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-primary/10 text-primary">
                  <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" />
                </div>
                <div className={cn('min-w-0', collapsed ? 'hidden' : 'hidden md:block')}>
                  {/* Product wordmark stays English in every locale, like the
                      extension name in the Chrome UI. */}
                  <p className="truncate text-sm font-semibold leading-tight text-foreground">
                    Lumo Userscripts
                  </p>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-lumo px-2 py-1">
                <div className="space-y-0.5">
                  {NAV.map((item) => {
                    const isActive = active === item.name;
                    return (
                      <Tooltip key={item.name}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => navigate({ name: item.name })}
                            aria-current={isActive ? 'page' : undefined}
                            className={cn(
                              'relative flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-sm',
                              'transition-colors duration-150 ease-standard',
                              isActive
                                ? 'font-medium text-foreground'
                                : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                              collapsed ? 'md:justify-center md:px-0' : 'md:justify-start',
                            )}
                          >
                            {isActive && (
                              <motion.span
                                layoutId="options-nav-active"
                                aria-hidden="true"
                                className="absolute inset-0 rounded-control bg-accent"
                                transition={{ type: 'spring', stiffness: 560, damping: 44, mass: 0.6 }}
                              />
                            )}
                            <span
                              className={cn(
                                'relative z-10 shrink-0',
                                isActive ? 'text-primary' : '',
                              )}
                            >
                              {item.icon}
                            </span>
                            <span
                              className={cn(
                                'text-optical relative z-10 min-w-0 truncate',
                                collapsed ? 'hidden' : 'hidden md:inline',
                              )}
                            >
                              {t(item.labelKey)}
                            </span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right" className={collapsed ? '' : 'md:hidden'}>
                          {t(item.labelKey)}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>

              <div
                className={cn(
                  'flex h-12 shrink-0 items-center border-t border-border px-2',
                  collapsed ? 'md:justify-center' : 'md:justify-end',
                )}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="iconSm"
                      onClick={() => setCollapsed((value) => !value)}
                      aria-label={t(collapsed ? 'options.nav.expand' : 'options.nav.collapse')}
                      className="hidden md:inline-flex"
                    >
                      {collapsed ? (
                        <PanelLeftOpen className="h-3.5 w-3.5" />
                      ) : (
                        <PanelLeftClose className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {t(collapsed ? 'options.nav.expand' : 'options.nav.collapse')}
                  </TooltipContent>
                </Tooltip>
              </div>
            </nav>

            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-lumo scroll-container">
              <div
                key={route.name}
                style={{ viewTransitionName: 'page-content' }}
                className={route.name === 'editor' ? 'h-full' : 'min-h-full'}
              >
                {content}
              </div>
            </main>
          </div>
        </ToastProvider>
      </TooltipProvider>
    </MotionConfig>
  );
}
