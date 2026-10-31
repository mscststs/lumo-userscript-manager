import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { sendBg, onLumoEvent } from '@/lib/messages';
import { cn } from '@/lib/utils';
import { useStorageWatch } from '@/store/useStorageWatch';
import { useAgentAccess } from '@/store/useAgentAccess';
import { BrandMark } from '@/components/brand/BrandMark';
import { AgentAccessDialog } from '@/components/agent/AgentAccessDialog';
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
type SettingsSection = 'general' | 'updates' | 'data' | 'agent';

interface Route {
  name: RouteName;
  uuid?: string;
  /** Optional editor panel opened by a deep link from the popup. */
  panel?: string;
  section?: SettingsSection;
}

const SETTINGS_SECTIONS: SettingsSection[] = ['general', 'updates', 'data', 'agent'];

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

function useHashRoute() {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    // Route changes commit synchronously: no cross-fade, no ghost snapshot. The
    // old page is never visible on top of the new one, so a page that loads its
    // own data cannot appear to "flash back" mid-navigation.
    window.location.hash = routeToHash(next);
    setRoute(next);
  }, []);

  return { route, navigate };
}

const NAV: {
  name: Exclude<RouteName, 'editor'>;
  labelKey: string;
  icon: ReactNode;
}[] = [
  { name: 'scripts', labelKey: 'options.nav.scripts', icon: <FileCode2 className="h-4 w-4" /> },
  { name: 'settings', labelKey: 'options.nav.settings', icon: <Settings className="h-4 w-4" /> },
  { name: 'appearance', labelKey: 'options.nav.appearance', icon: <Palette className="h-4 w-4" /> },
  // Diagnostics sit next to the page that owns the build info: both answer
  // "what is going on inside the extension", unlike the settings above them.
  { name: 'logs', labelKey: 'options.nav.logs', icon: <ScrollText className="h-4 w-4" /> },
  { name: 'about', labelKey: 'options.nav.about', icon: <Info className="h-4 w-4" /> },
];

/**
 * Errors logged since the log view was last on screen.
 *
 * Re-counted when the log store changes and when the "seen" pointer moves — the
 * log page advances it — so opening the log view in one window clears the
 * badge in every other window too.
 */
function useUnreadErrors(): number {
  const [errors, setErrors] = useState(0);

  const refresh = useCallback(() => {
    void sendBg<{ errors: number }>('logs:unread')
      .then((result) => setErrors(result.errors))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    return onLumoEvent((event) => {
      if (event === 'logs-changed') refresh();
    });
  }, [refresh]);
  useStorageWatch('logsSeenAt', refresh);

  return errors;
}

export default function App() {
  const { t } = useTranslation();
  const { route, navigate } = useHashRoute();
  const [collapsed, setCollapsed] = useState(false);
  const active = route.name === 'editor' ? 'scripts' : route.name;
  const unreadErrors = useUnreadErrors();
  // Shared with the approval dialog: the same queue drives the nav badge.
  const agentAccess = useAgentAccess();

  const content = useMemo(() => {
    if (route.name === 'scripts') {
      return (
        <ScriptsPage
          onOpenEditor={(uuid) => navigate({ name: 'editor', uuid })}
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
          {/* The window is the frame: the sidebar shares its colour and the page
              sits on it as one raised panel. Navigation reads as part of the
              window rather than as a second pane competing with the content. */}
          <div className="flex h-dvh w-full overflow-hidden bg-sidebar text-foreground">
            <ThemeInit />
            <FontSizeInit />

            <nav
              aria-label={t('options.nav.label')}
              className={cn(
                'flex h-full shrink-0 flex-col py-2 transition-[width] duration-200 ease-standard',
                collapsed ? 'w-14' : 'w-14 md:w-56',
              )}
            >
              <div
                className={cn(
                  'flex h-14 shrink-0 items-center gap-2.5 px-3.5',
                  !collapsed && 'md:px-4',
                )}
              >
                <BrandMark className="h-7 w-7" />
                <p
                  className={cn(
                    'min-w-0 max-w-0 overflow-hidden truncate text-sm font-semibold text-foreground opacity-0',
                    'transition-[max-width,opacity] duration-200 ease-standard',
                    !collapsed && 'md:max-w-[11rem] md:opacity-100',
                  )}
                >
                  {/* Product wordmark stays English in every locale, like the
                      extension name in the Chrome UI. */}
                  Lumo Userscripts
                </p>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-lumo px-2 py-1">
                <div className="space-y-0.5">
                  {NAV.map((item) => {
                    const isActive = active === item.name;
                    const pendingAccess = item.name === 'settings' ? agentAccess.actionable.length : 0;
                    const badge = isActive
                      ? 0
                      : item.name === 'logs'
                        ? unreadErrors
                        : pendingAccess;
                    // Amber for a decision waiting on the user, red for faults:
                    // a pending request is not an error.
                    const tone =
                      item.name === 'settings'
                        ? { dot: 'bg-warning', pill: 'bg-warning text-warning-foreground' }
                        : {
                            dot: 'bg-destructive',
                            pill: 'bg-destructive text-destructive-foreground',
                          };
                    const label = t(item.labelKey);
                    return (
                      <Tooltip key={item.name}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => navigate({ name: item.name })}
                            aria-current={isActive ? 'page' : undefined}
                            // Named explicitly: the visible label collapses to
                            // zero width, which would leave the button nameless.
                            aria-label={
                              badge > 0
                                ? t(
                                    item.name === 'settings'
                                      ? 'options.nav.pendingRequests'
                                      : 'options.nav.unreadErrors',
                                    { label, count: badge },
                                  )
                                : label
                            }
                            className={cn(
                              'relative flex h-8 w-full items-center gap-2.5 rounded-control pl-3 text-sm',
                              'transition-colors duration-150 ease-standard',
                              isActive
                                ? 'font-medium text-foreground'
                                : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                            )}
                          >
                            {/* The selection is a raised chip — the same object
                                as the segmented thumb — and slides between rows
                                rather than blinking from one to the next. */}
                            {isActive && (
                              <motion.span
                                layoutId="options-nav-active"
                                aria-hidden="true"
                                className="absolute inset-0 rounded-control border border-border/60 bg-card shadow-elev1"
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
                              {badge > 0 && (
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    'absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full',
                                    tone.dot,
                                    collapsed ? '' : 'md:hidden',
                                  )}
                                />
                              )}
                            </span>
                            <span
                              className={cn(
                                'text-optical relative z-10 min-w-0 max-w-0 flex-1 truncate text-left opacity-0',
                                'transition-[max-width,opacity] duration-200 ease-standard',
                                !collapsed && 'md:max-w-48 md:opacity-100',
                              )}
                            >
                              {label}
                            </span>
                            {badge > 0 && (
                              <span
                                aria-hidden="true"
                                className={cn(
                                  'relative z-10 h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs font-semibold tabular-nums leading-none',
                                  tone.pill,
                                  collapsed ? 'hidden' : 'hidden md:inline-flex',
                                )}
                              >
                                {badge > 99 ? '99+' : badge}
                              </span>
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right" className={collapsed ? '' : 'md:hidden'}>
                          {label}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>

              {/* The collapse control keeps a constant inset from the rail's
                  right edge. The rail width animates, so the button slides left
                  as the panel closes and *ends* centred — it never jumps to the
                  middle of the still-wide rail first. */}
              <div className="hidden h-10 shrink-0 items-center justify-end pr-3.5 md:flex">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="iconSm"
                      onClick={() => setCollapsed((value) => !value)}
                      aria-label={t(collapsed ? 'options.nav.expand' : 'options.nav.collapse')}
                      className="text-muted-foreground"
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

            {/* Each page owns its scrolling (see PageLayout): the panel itself
                never scrolls, so its rounded corners and the page heading stay
                put while the content moves underneath. */}
            <main className="my-2 mr-2 min-h-0 min-w-0 flex-1 overflow-hidden rounded-card border border-border/70 bg-background shadow-panel">
              <div key={route.name} className="h-full">
                {content}
              </div>
            </main>
          </div>

          {/* A pending access request is an interrupt, not a page section: the
              dialog is mounted above the routed page so the queue stays
              actionable from any route. */}
          <AgentAccessDialog access={agentAccess} />
        </ToastProvider>
      </TooltipProvider>
    </MotionConfig>
  );
}
