import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, CircleAlert, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

type ToastVariant = 'default' | 'success' | 'error';

interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. Errors default to 6s, everything else 3s. */
  duration?: number;
}

const ToastContext = React.createContext<(input: ToastInput) => void>(() => {});

/**
 * Toasts.
 *
 * Settings pages used to report "saved" with a bare paragraph above the form:
 * it was easy to miss, never disappeared, and a later error silently replaced
 * it. A toast is the right shape because the feedback is *about an action*, not
 * about the page — it should not occupy layout, and it should announce itself.
 *
 * Living region contract: the container is `aria-live="polite"` and
 * `aria-atomic="false"` so a screen reader reads each message once. Errors use
 * `role="alert"` so they interrupt instead of queueing behind other speech.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const durations = React.useRef(new Map<string, number>());
  // A toast must not disappear while the user is reading it or tabbing to its
  // close control. Pause on hover and on focus inside, and only restart when
  // both are gone.
  const interaction = React.useRef(new Map<string, { hover: boolean; focus: boolean }>());

  const startTimer = React.useCallback((id: string) => {
    const duration = durations.current.get(id);
    if (duration === undefined) return;
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    timers.current.set(
      id,
      setTimeout(() => {
        // The timer can outlive the toast during a fast dismiss/reopen cycle.
        setToasts((current) => current.filter((toast) => toast.id !== id));
        timers.current.delete(id);
        durations.current.delete(id);
        interaction.current.delete(id);
      }, duration),
    );
  }, []);

  const dismiss = React.useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    durations.current.delete(id);
    interaction.current.delete(id);
  }, []);

  const setInteraction = React.useCallback(
    (id: string, kind: 'hover' | 'focus', active: boolean) => {
      const state = interaction.current.get(id) ?? { hover: false, focus: false };
      state[kind] = active;
      interaction.current.set(id, state);
      if (state.hover || state.focus) {
        const timer = timers.current.get(id);
        if (timer) clearTimeout(timer);
        timers.current.delete(id);
      } else {
        startTimer(id);
      }
    },
    [startTimer],
  );

  const push = React.useCallback(
    (input: ToastInput) => {
      const id = crypto.randomUUID();
      const variant = input.variant ?? 'default';
      const duration = input.duration ?? (variant === 'error' ? 6000 : 3000);
      setToasts((current) => [...current.slice(-2), { ...input, id, variant, duration }]);
      durations.current.set(id, duration);
      interaction.current.set(id, { hover: false, focus: false });
      startTimer(id);
    },
    [startTimer],
  );

  React.useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      durations.current.clear();
      interaction.current.clear();
    },
    [],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        role="region"
        aria-label={t('common.notifications')}
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 end-4 z-[70] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.99 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              role={toast.variant === 'error' ? 'alert' : 'status'}
              onMouseEnter={() => setInteraction(toast.id, 'hover', true)}
              onMouseLeave={() => setInteraction(toast.id, 'hover', false)}
              onFocusCapture={() => setInteraction(toast.id, 'focus', true)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setInteraction(toast.id, 'focus', false);
                }
              }}
              className={cn(
                'pointer-events-auto flex items-start gap-2.5 rounded-card border bg-popover px-3 py-2.5 shadow-elev2',
                toast.variant === 'error'
                  ? 'border-destructive/30'
                  : toast.variant === 'success'
                    ? 'border-success/30'
                    : 'border-border',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 shrink-0',
                  toast.variant === 'error'
                    ? 'text-destructive'
                    : toast.variant === 'success'
                      ? 'text-success'
                      : 'text-muted-foreground',
                )}
              >
                {toast.variant === 'error' ? (
                  <CircleAlert className="h-3.5 w-3.5" />
                ) : toast.variant === 'success' ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Info className="h-3.5 w-3.5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground">{toast.title}</p>
                {toast.description && (
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-2xs leading-relaxed text-muted-foreground">
                    {toast.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={t('common.close')}
              >
                <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                  <path
                    d="M2.5 2.5l7 7m0-7l-7 7"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return React.useContext(ToastContext);
}
