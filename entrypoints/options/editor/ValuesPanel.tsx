import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/layout/EmptyState';
import { CodeView } from '@/components/code/CodeView';
import { SettingsGroup } from '@/components/settings/SettingsGroup';

/**
 * `GM_setValue` store for one script.
 *
 * Values are JSON — a userscript can store anything, so the input accepts any
 * JSON document and rejects it inline instead of at save time. The keys are
 * `GM_setValue` names, not free-form labels, hence mono throughout.
 */
export function ValuesPanel({
  values,
  onAdd,
  onDelete,
}: {
  values: Record<string, unknown>;
  onAdd: (key: string, value: unknown) => void | Promise<void>;
  onDelete: (key: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const entries = Object.entries(values);

  const submit = async () => {
    const name = key.trim();
    if (!name) return;
    let parsed: unknown;
    try {
      parsed = draft.trim() ? JSON.parse(draft) : '';
    } catch {
      setError(t('editor.valueInvalid'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onAdd(name, parsed);
      setKey('');
      setDraft('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsGroup title={t('editor.groupValues')} description={t('editor.valuesHint')}>
        {entries.length === 0 ? (
          <EmptyState
            icon={Database}
            title={t('editor.emptyValues')}
            description={t('editor.emptyValuesDescription')}
            className="py-8"
          />
        ) : (
          entries.map(([name, value]) => (
            <div key={name} className="py-3">
              <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">
                  {name}
                </code>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="iconSm"
                      aria-label={t('editor.deleteValue')}
                      onClick={() => void onDelete(name)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">{t('editor.deleteValue')}</TooltipContent>
                </Tooltip>
              </div>
              <div className="scrollbar-lumo mt-1.5 max-h-40 overflow-auto rounded-control border border-border bg-code-bg px-2.5 py-2">
                <CodeView
                  code={JSON.stringify(value, null, 2) ?? String(value)}
                  lang="json"
                  className="[&_pre]:whitespace-pre-wrap [&_pre]:break-all"
                />
              </div>
            </div>
          ))
        )}
      </SettingsGroup>

      <SettingsGroup title={t('editor.groupAddValue')}>
        <Field className="py-3" label={t('editor.key')}>
          {(props) => (
            <Input
              {...props}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="GM_setValue key"
              spellCheck={false}
              className="max-w-xs font-mono text-xs"
            />
          )}
        </Field>
        <Field
          className="py-3"
          label={t('editor.value')}
          hint={t('editor.addValueHint')}
          error={error ?? undefined}
        >
          {(props) => (
            <Textarea
              {...props}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (error) setError(null);
              }}
              placeholder={'"text" · 42 · true · {"a":1}'}
              spellCheck={false}
              rows={3}
              className="min-h-0 font-mono text-xs"
            />
          )}
        </Field>
        <div className="flex justify-end py-3">
          <Button
            variant="outline"
            size="sm"
            disabled={!key.trim() || busy}
            onClick={() => void submit()}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('editor.addValue')}
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
}
