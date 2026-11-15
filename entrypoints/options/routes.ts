import { lazy } from 'react';

/**
 * Route modules for the options page.
 *
 * Pages are code-split so the initial options bundle never carries CodeMirror,
 * Shiki or the backup code. The split has a cost though: the first navigation to
 * a page mounts a `React.lazy` component, which suspends once even when the
 * chunk is already in memory. Warming the module ahead of the click removes
 * that disk/parse wait; the navigation itself keeps the previous page visible
 * (see `navigate` in `App.tsx`) so a cold page never flashes a skeleton.
 */
type AnyComponent = (props: never) => unknown;

type PageLoader = () => Promise<{ default: AnyComponent }>;

const LOADERS = {
  scripts: async () => ({ default: (await import('./ScriptsPage')).ScriptsPage as AnyComponent }),
  editor: async () => ({ default: (await import('./EditorPage')).EditorPage as AnyComponent }),
  settings: async () => ({ default: (await import('./SettingsPage')).SettingsPage as AnyComponent }),
  logs: async () => ({ default: (await import('./LogsPage')).LogsPage as AnyComponent }),
  about: async () => ({ default: (await import('./About')).AboutPage as AnyComponent }),
  appearance: async () => ({
    default: (await import('./AppearancePage')).AppearancePage as AnyComponent,
  }),
} satisfies Record<string, PageLoader>;

export type PageName = keyof typeof LOADERS;

/**
 * One promise per page for the lifetime of the document.
 *
 * `React.lazy` memoises internally, but an explicit cache lets the hover/focus
 * prefetch and the lazy factory share the same in-flight import instead of
 * starting two of them.
 */
const pages = new Map<PageName, Promise<{ default: AnyComponent }>>();

export function loadPage(name: PageName): Promise<{ default: AnyComponent }> {
  let pending = pages.get(name);
  if (!pending) {
    pending = LOADERS[name]();
    pages.set(name, pending);
  }
  return pending;
}

/** Fire-and-forget warm-up; a failed import is retried on the next attempt. */
export function preloadPage(name: PageName): void {
  void loadPage(name).catch(() => pages.delete(name));
}

export const ScriptsPage = lazy(
  async () =>
    ({ default: (await loadPage('scripts')).default }) as {
      default: (typeof import('./ScriptsPage'))['ScriptsPage'];
    },
);
export const EditorPage = lazy(
  async () =>
    ({ default: (await loadPage('editor')).default }) as {
      default: (typeof import('./EditorPage'))['EditorPage'];
    },
);
export const SettingsPage = lazy(
  async () =>
    ({ default: (await loadPage('settings')).default }) as {
      default: (typeof import('./SettingsPage'))['SettingsPage'];
    },
);
export const LogsPage = lazy(
  async () =>
    ({ default: (await loadPage('logs')).default }) as {
      default: (typeof import('./LogsPage'))['LogsPage'];
    },
);
export const AboutPage = lazy(
  async () =>
    ({ default: (await loadPage('about')).default }) as {
      default: (typeof import('./About'))['AboutPage'];
    },
);
export const AppearancePage = lazy(
  async () =>
    ({ default: (await loadPage('appearance')).default }) as {
      default: (typeof import('./AppearancePage'))['AppearancePage'];
    },
);

/**
 * Pages small enough to warm during idle time on every visit. The editor is
 * excluded on purpose: it pulls CodeMirror and Shiki, which should only load
 * when the user actually heads into the editor (hover or click).
 */
const IDLE_PAGES: PageName[] = ['settings', 'appearance', 'logs', 'about'];

export function preloadIdlePages(): void {
  const run = () => {
    for (const name of IDLE_PAGES) preloadPage(name);
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 1200);
  }
}
