import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Globe, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  detectLanguage,
  findLocale,
  sortLocalesForPicker,
  type LanguagePreference,
  type LocaleDescriptor,
} from '@/i18n/locales';

interface LanguagePickerProps {
  value: LanguagePreference;
  onChange: (value: LanguagePreference) => void;
  className?: string;
  /** Lets the surrounding SettingRow label target this control. */
  id?: string;
}

/**
 * Language selector for the personalisation page.
 *
 * A plain `Select` stops working around 55 entries: the menu is taller than the
 * viewport and has no way to search. This keeps the same trigger geometry as
 * every other setting (so it reads as one system) but opens a searchable list —
 * the pattern Chrome, VS Code and macOS all use once a language list gets long.
 *
 * The list is ordered by native name in the *active* language's collation, with
 * the current language and English pinned: users looking for their own language
 * should not have to scroll past 50 others.
 */
export function LanguagePicker({ value, onChange, className, id }: LanguagePickerProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const detected = findLocale(detectLanguage());
  const selected = value === 'auto' ? undefined : findLocale(value);
  const triggerLabel =
    value === 'auto'
      ? `${t('options.appearance.languageAuto')}${detected ? ` · ${detected.native}` : ''}`
      : (selected?.native ?? value);

  const locales = useMemo(() => sortLocalesForPicker(i18n.language), [i18n.language]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return locales;
    return locales.filter((locale) =>
      [locale.native, locale.english, locale.tag, locale.chrome].some((field) =>
        field.toLowerCase().includes(needle)
      )
    );
  }, [locales, query]);

  // `auto` is always first: it is the default and the only option that is not a
  // language, so it must not be interleaved with the alphabetical list.
  const showAuto = !query.trim() || 'auto'.includes(query.trim().toLowerCase());

  const rows = useMemo(
    () => (showAuto ? [null, ...filtered] : filtered),
    [filtered, showAuto]
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const commit = (next: LanguagePreference) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setActiveIndex((index) => (index + delta + rows.length) % rows.length);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(0, rows.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[activeIndex];
      commit(row ? (row.tag as LanguagePreference) : 'auto');
    }
  };

  const isSelected = (row: LocaleDescriptor | null) =>
    row ? row.tag === value : value === 'auto';

  return (
    <>
      <Button
        id={id}
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        aria-label={t('options.appearance.language')}
        className={cn(
          // Reads as a form control, not an action: same height, padding, icon
          // sizes and surface as `Select` and `Input`, and the same quiet
          // hover. It is a `Button` only because it opens a searchable dialog
          // instead of a listbox (55 locales).
          'h-8 w-56 justify-between gap-2 px-2.5 font-normal',
          'border-input bg-background shadow-none hover:border-muted-foreground/50 hover:bg-background hover:text-foreground',
          className
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm" dir="auto">
            {triggerLabel}
          </span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-3 p-4">
          <DialogHeader>
            <DialogTitle>{t('options.appearance.language')}</DialogTitle>
          </DialogHeader>

          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={t('options.appearance.languageSearch')}
              aria-label={t('options.appearance.languageSearch')}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                rows[activeIndex]
                  ? `locale-option-${rows[activeIndex]!.tag}`
                  : 'locale-option-auto'
              }
              className="h-9 ps-9"
            />
          </div>

          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={t('options.appearance.language')}
            className="max-h-[min(50vh,420px)] overflow-y-auto scrollbar-lumo -mx-1 px-1"
          >
            {rows.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {t('common.noResults')}
              </p>
            ) : (
              rows.map((row, index) => {
                const selectedRow = isSelected(row);
                return (
                  <button
                    key={row?.tag ?? 'auto'}
                    type="button"
                    id={row ? `locale-option-${row.tag}` : 'locale-option-auto'}
                    role="option"
                    aria-selected={selectedRow}
                    tabIndex={-1}
                    data-index={index}
                    data-active={index === activeIndex || undefined}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(row ? (row.tag as LanguagePreference) : 'auto')}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-start transition-colors',
                      'data-[active]:bg-accent data-[active]:text-accent-foreground'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm" dir="auto">
                        {row ? row.native : t('options.appearance.languageAuto')}
                      </span>
                      <span className="block truncate text-[0.6875rem] text-muted-foreground" dir="auto">
                        {row ? row.english : t('options.appearance.languageAutoDesc')}
                      </span>
                    </span>
                    {selectedRow && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
