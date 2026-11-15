import * as React from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * Native modal dialog.
 *
 * Chrome 138 provides everything a custom overlay used to rebuild: top layer,
 * `::backdrop`, page inertness, focus containment, Esc/back dismissal and focus
 * return to the invoker. The component keeps the same compound API as before,
 * so call sites only changed where a native control differs.
 */

interface DialogContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

// Native modal dialogs make the page inert but do not lock its scrollbar.
// Keep the previous Radix behaviour, with a counter so nested dialogs restore
// the document only after the last one closes.
let scrollLockCount = 0;
let scrollLockStyles:
  | { rootOverflow: string; bodyOverflow: string; bodyPaddingRight: string }
  | null = null;

function lockDocumentScroll(): void {
  if (typeof document === 'undefined') return;
  scrollLockCount += 1;
  if (scrollLockCount !== 1) return;
  const root = document.documentElement;
  const body = document.body;
  const gap = Math.max(0, window.innerWidth - root.clientWidth);
  scrollLockStyles = {
    rootOverflow: root.style.overflow,
    bodyOverflow: body.style.overflow,
    bodyPaddingRight: body.style.paddingRight,
  };
  if (gap > 0) body.style.paddingRight = `${gap}px`;
  root.style.overflow = 'hidden';
  body.style.overflow = 'hidden';
}

function unlockDocumentScroll(): void {
  if (typeof document === 'undefined') return;
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount !== 0 || !scrollLockStyles) return;
  const root = document.documentElement;
  const body = document.body;
  root.style.overflow = scrollLockStyles.rootOverflow;
  body.style.overflow = scrollLockStyles.bodyOverflow;
  body.style.paddingRight = scrollLockStyles.bodyPaddingRight;
  scrollLockStyles = null;
}

function useDialogContext(component: string): DialogContextValue {
  const context = React.useContext(DialogContext);
  if (!context) throw new Error(`<${component}> must be used inside <Dialog>`);
  return context;
}

interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

const Dialog = ({ open: openProp, defaultOpen = false, onOpenChange, children }: DialogProps) => {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : uncontrolled;
  const titleId = React.useId();
  const descriptionId = React.useId();

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!controlled) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  const value = React.useMemo(
    () => ({ open, onOpenChange: setOpen, titleId, descriptionId }),
    [open, setOpen, titleId, descriptionId],
  );

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
};

function cloneTrigger(
  children: React.ReactNode,
  handler: (event: React.MouseEvent) => void,
): React.ReactNode {
  const child = React.Children.only(children) as React.ReactElement<{
    onClick?: (event: React.MouseEvent) => void;
  }>;
  return React.cloneElement(child, {
    onClick: (event: React.MouseEvent) => {
      child.props.onClick?.(event);
      if (!event.defaultPrevented) handler(event);
    },
  });
}

const DialogTrigger = ({
  children,
  asChild = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) => {
  const { onOpenChange } = useDialogContext('DialogTrigger');
  const open = () => onOpenChange(true);
  if (asChild) return <>{cloneTrigger(children, open)}</>;
  return (
    <button type="button" {...props} onClick={() => open()}>
      {children}
    </button>
  );
};

const DialogClose = ({
  children,
  asChild = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) => {
  const { onOpenChange } = useDialogContext('DialogClose');
  const close = () => onOpenChange(false);
  if (asChild) return <>{cloneTrigger(children, close)}</>;
  return (
    <button type="button" {...props} onClick={() => close()}>
      {children}
    </button>
  );
};

interface DialogContentProps extends React.DialogHTMLAttributes<HTMLDialogElement> {
  /** Render the built-in top-right close button. Defaults to true. */
  showCloseButton?: boolean;
  /** Accessible label for the close button. */
  closeLabel?: string;
  /** ARIA role. Use `alertdialog` for destructive confirmations. */
  role?: 'dialog' | 'alertdialog';
}

const DialogContent = React.forwardRef<HTMLDialogElement, DialogContentProps>(
  ({ className, children, showCloseButton = true, closeLabel, role = 'dialog', ...props }, ref) => {
    const { t } = useTranslation();
    const { open, onOpenChange, titleId, descriptionId } = useDialogContext('DialogContent');
    const innerRef = React.useRef<HTMLDialogElement>(null);
    const label = closeLabel ?? t('common.close');

    React.useImperativeHandle(ref, () => innerRef.current as HTMLDialogElement);

    React.useEffect(() => {
      const dialog = innerRef.current;
      if (!dialog) return;
      if (open) {
        if (!dialog.open) {
          try {
            if (typeof dialog.showModal === 'function') dialog.showModal();
            // jsdom (component tests) has no showModal; an open attribute keeps
            // the dialog and its accessible role in the tree.
            else dialog.setAttribute('open', '');
          } catch {
            // The element may be detached during a fast route transition.
          }
        }
      } else if (dialog.open) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
    }, [open]);

    React.useEffect(() => {
      const dialog = innerRef.current;
      if (!dialog) return;
      const handleClose = () => onOpenChange(false);
      dialog.addEventListener('close', handleClose);
      return () => dialog.removeEventListener('close', handleClose);
    }, [onOpenChange]);

    React.useEffect(() => {
      if (!open) return;
      lockDocumentScroll();
      return unlockDocumentScroll;
    }, [open]);

    return (
      <dialog
        {...props}
        ref={innerRef}
        role={role === 'alertdialog' ? 'alertdialog' : undefined}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        // Native light dismiss. `cancel`/Esc still works everywhere; the
        // attribute is Chrome 134+ and the project floor is 138.
        {...({ closedby: 'any' } as Record<string, string>)}
        className={cn(
          'lumo-dialog m-auto w-[calc(100%-2rem)] max-w-md flex-col gap-4 rounded-card border border-border bg-card p-5 text-foreground shadow-elev3',
          'max-h-[calc(100dvh-3rem)] overflow-y-auto scrollbar-lumo',
          className,
        )}
      >
        {children}
        {showCloseButton && (
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="absolute end-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={label}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </dialog>
    );
  },
);
DialogContent.displayName = 'DialogContent';

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 pe-8', className)} {...props} />;
}

function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-sm leading-relaxed text-muted-foreground', className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, children, ...props }, ref) => {
    const { titleId } = useDialogContext('DialogTitle');
    return (
      <h2
        id={titleId}
        ref={ref}
        className={cn('text-base font-semibold leading-tight text-foreground', className)}
        {...props}
      >
        {children}
      </h2>
    );
  },
);
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => {
  const { descriptionId } = useDialogContext('DialogDescription');
  return (
    <p
      id={descriptionId}
      ref={ref}
      className={cn('text-sm leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
});
DialogDescription.displayName = 'DialogDescription';

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogTrigger,
};
