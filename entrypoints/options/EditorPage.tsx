import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Info, Play, Plus, Save, Trash2 } from 'lucide-react';
import type { LogEntry, ScriptMetadata, ScriptVersion, StoredResource, UserScript } from '@/types';
import { sendBg } from '@/lib/messages';
import { parseMetadata, getMeta, getMetaList } from '@/lib/script/metadata';
import { newScriptTemplate } from '@/lib/script/template';
import { formatBytes } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import { CodeEditor } from '@/components/editor/CodeEditor';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface ScriptDetail {
  script: UserScript & { code: string };
  resources: StoredResource[];
  values: Record<string, unknown>;
  versions: ScriptVersion[];
}

interface EditorPageProps {
  uuid?: string;
  /** Panel to focus when opened from a deep link (e.g. the popup). */
  initialPanel?: string;
  onBack: () => void;
  onSaved: (uuid: string) => void;
}

type Panel = 'metadata' | 'values' | 'resources' | 'info';

const PANEL_IDS: Panel[] = ['metadata', 'values', 'resources', 'info'];

function isPanel(value: string | undefined): value is Panel {
  return PANEL_IDS.includes(value as Panel);
}

function linesToMeta(key: string, text: string): string[] | undefined {
  const values = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function metaToLines(metadata: ScriptMetadata, key: string): string {
  return (metadata[key] ?? []).join('\n');
}

function splitSelfMetadata(metadata: ScriptMetadata): ScriptMetadata {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

export function EditorPage({ uuid, initialPanel, onBack, onSaved }: EditorPageProps) {
  const { t, i18n } = useTranslation();
  const isNew = !uuid || uuid === 'new';
  const [code, setCode] = useState(() => newScriptTemplate());
  const [originalCode, setOriginalCode] = useState('');
  const [script, setScript] = useState<(UserScript & { code: string }) | null>(null);
  const [selfMetadata, setSelfMetadata] = useState<ScriptMetadata>({});
  const [resources, setResources] = useState<StoredResource[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [panel, setPanel] = useState<Panel>(() =>
    isPanel(initialPanel) ? initialPanel : 'metadata',
  );
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const parsed = useMemo(() => parseMetadata(code), [code]);
  const dirty = code !== originalCode;

  const load = useCallback(async () => {
    if (isNew || !uuid) {
      const template = newScriptTemplate();
      setCode(template);
      setOriginalCode(template);
      setScript(null);
      setSelfMetadata({});
      setResources([]);
      setValues({});
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const detail = await sendBg<ScriptDetail | null>('scripts:getDetail', { uuid });
      if (!detail) throw new Error(t('editor.notFound'));
      setScript(detail.script);
      setCode(detail.script.code);
      setOriginalCode(detail.script.code);
      setSelfMetadata(detail.script.selfMetadata ?? {});
      setResources(detail.resources);
      setValues(detail.values);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [isNew, t, uuid]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (isPanel(initialPanel)) setPanel(initialPanel);
  }, [initialPanel]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const save = async () => {
    if (parsed.errors.length) {
      setError(parsed.errors.join('\n'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await sendBg<UserScript>('scripts:save', {
        uuid: script?.uuid ?? null,
        code,
      });
      setScript({ ...result, code });
      setOriginalCode(code);
      setMessage(t('editor.saved'));
      onSaved(result.uuid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveOverrides = async () => {
    if (!script) {
      setMessage(t('editor.saveMetadata'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await sendBg<UserScript>('scripts:updateMetadata', {
        uuid: script.uuid,
        selfMetadata: splitSelfMetadata(selfMetadata),
      });
      setScript({ ...next, code });
      setMessage(t('editor.metadataSaved'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const addValue = async () => {
    if (!script || !newKey.trim()) return;
    try {
      const parsedValue = newValue.trim() ? JSON.parse(newValue) : '';
      await sendBg('values:set', { uuid: script.uuid, key: newKey, value: parsedValue });
      setValues((prev) => ({ ...prev, [newKey]: parsedValue }));
      setNewKey('');
      setNewValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteValue = async (key: string) => {
    if (!script) return;
    await sendBg('values:delete', { uuid: script.uuid, key });
    setValues((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const run = async () => {
    if (!script) {
      setMessage(t('editor.saveMetadata'));
      return;
    }
    if (dirty) {
      setError(t('editor.unsaved'));
      return;
    }
    try {
      await sendBg('scripts:run', { uuid: script.uuid });
      setMessage(t('editor.runStarted'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const updateOverride = (key: string, value: string[] | undefined) => {
    setSelfMetadata((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  if (loading) {
    return <p className="text-xs text-muted-foreground">{t('common.loading')}</p>;
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">
              {script?.name ?? t('editor.newTitle')}
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {dirty ? t('editor.unsaved') : script?.namespace || t('scripts.noSource')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {message && <span className="text-[11px] text-muted-foreground">{message}</span>}
          <Button variant="outline" size="sm" onClick={() => void run()} disabled={!script}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {t('editor.run')}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {saving ? t('editor.saving') : t('editor.save')}
          </Button>
        </div>
      </header>

      {error && <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
      {parsed.errors.length > 0 && (
        <p className="whitespace-pre-wrap text-xs text-destructive">{parsed.errors.join('\n')}</p>
      )}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-h-[420px] overflow-hidden rounded-lg border border-border bg-card">
          <CodeEditor value={code} onChange={setCode} className="h-[calc(100vh-13rem)]" />
        </div>

        <aside className="flex min-h-0 flex-col rounded-lg border border-border bg-card">
          <div className="flex gap-1 overflow-x-auto border-b border-border p-1.5 scrollbar-lumo">
            {PANEL_IDS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setPanel(item)}
                className={`shrink-0 rounded px-2.5 py-1 text-[11px] transition-colors ${
                  panel === item
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                {t(`editor.${item}`)}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto scrollbar-lumo p-3">
            {panel === 'metadata' && (
              <MetadataPanel
                metadata={parsed.metadata}
                selfMetadata={selfMetadata}
                onChange={updateOverride}
                onSave={() => void saveOverrides()}
                disabled={!script}
              />
            )}

            {panel === 'values' && (
              <div className="space-y-3">
                {Object.keys(values).length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('editor.emptyValues')}</p>
                ) : (
                  <div className="space-y-2">
                    {Object.entries(values).map(([key, value]) => (
                      <div key={key} className="rounded-md border border-border p-2">
                        <div className="flex items-center justify-between gap-2">
                          <code className="truncate text-[11px] font-medium">{key}</code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => void deleteValue(key)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
                          {JSON.stringify(value, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
                <Separator />
                <Input
                  value={newKey}
                  onChange={(event) => setNewKey(event.target.value)}
                  placeholder={t('editor.key')}
                  className="h-8 text-xs"
                />
                <Textarea
                  value={newValue}
                  onChange={(event) => setNewValue(event.target.value)}
                  placeholder={t('editor.value')}
                  className="min-h-16 text-xs"
                />
                <Button variant="outline" size="sm" className="w-full" onClick={() => void addValue()}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  {t('editor.addValue')}
                </Button>
              </div>
            )}

            {panel === 'resources' && (
              <div className="space-y-2">
                {resources.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('editor.emptyResources')}</p>
                ) : (
                  resources.map((resource) => (
                    <div key={`${resource.uuid}:${resource.url}`} className="rounded-md border border-border p-2">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline">{resource.kind}</Badge>
                        <span className="truncate text-[11px] font-medium">{resource.name}</span>
                      </div>
                      <p className="mt-1 break-all text-[10px] text-muted-foreground">{resource.url}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {formatBytes((resource.content?.length ?? 0) + (resource.base64?.length ?? 0))}
                      </p>
                    </div>
                  ))
                )}
              </div>
            )}

            {panel === 'info' && script && (
              <div className="space-y-3 text-[11px]">
                <InfoRow label={t('editor.name')} value={script.name} />
                <InfoRow label={t('editor.namespace')} value={script.namespace || '—'} />
                <InfoRow label={t('editor.version')} value={script.version || '—'} />
                <InfoRow label={t('editor.source')} value={script.origin || t('scripts.noSource')} />
                {script.homepage && (
                  <InfoRow label={t('editor.homepage')} value={script.homepage} />
                )}
                {script.supportUrl && (
                  <InfoRow label={t('editor.supportUrl')} value={script.supportUrl} />
                )}
                <InfoRow label={t('editor.codeSize')} value={formatBytes(script.codeSize)} />
                <InfoRow label={t('editor.lastUpdated')} value={formatDateTime(script.updatedAt, i18n.language)} />
                <InfoRow label={t('editor.runAt')} value={script.runAt} />
                <InfoRow label={t('editor.injectInto')} value={script.injectInto} />
                <InfoRow label={t('editor.lines')} value={String(code.split(/\r?\n/).length)} />
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-right text-foreground">{value}</span>
    </div>
  );
}

function MetadataPanel({
  metadata,
  selfMetadata,
  onChange,
  onSave,
  disabled,
}: {
  metadata: ScriptMetadata;
  selfMetadata: ScriptMetadata;
  onChange: (key: string, value: string[] | undefined) => void;
  onSave: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const effective = (key: string) => selfMetadata[key] ?? metadata[key] ?? [];

  return (
    <div className="space-y-3">
      <p className="text-[10px] leading-relaxed text-muted-foreground">{t('editor.overridesHint')}</p>
      <FieldText
        label={t('editor.match')}
        value={metaToLines({ ...metadata, ...selfMetadata }, 'match')}
        onChange={(value) => onChange('match', linesToMeta('match', value))}
        placeholder={metaToLines(metadata, 'match')}
      />
      <FieldText
        label={t('editor.include')}
        value={metaToLines({ ...metadata, ...selfMetadata }, 'include')}
        onChange={(value) => onChange('include', linesToMeta('include', value))}
        placeholder={metaToLines(metadata, 'include')}
      />
      <FieldText
        label={t('editor.exclude')}
        value={metaToLines({ ...metadata, ...selfMetadata }, 'exclude')}
        onChange={(value) => onChange('exclude', linesToMeta('exclude', value))}
        placeholder={metaToLines(metadata, 'exclude')}
      />
      <div className="space-y-1">
        <Label className="text-[11px]">{t('editor.runAt')}</Label>
        <Select
          value={selfMetadata['run-at']?.[0] ?? 'inherit'}
          onValueChange={(value) =>
            onChange('run-at', value === 'inherit' ? undefined : [value])
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t('common.unknown')}</SelectItem>
            <SelectItem value="document-start">document-start</SelectItem>
            <SelectItem value="document-body">document-body</SelectItem>
            <SelectItem value="document-end">document-end</SelectItem>
            <SelectItem value="document-idle">document-idle</SelectItem>
            <SelectItem value="context-menu">context-menu</SelectItem>
            <SelectItem value="early-start">early-start</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-[11px]">{t('editor.injectInto')}</Label>
        <Select
          value={selfMetadata['inject-into']?.[0] ?? 'inherit'}
          onValueChange={(value) =>
            onChange('inject-into', value === 'inherit' ? undefined : [value])
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">inherit</SelectItem>
            <SelectItem value="auto">auto</SelectItem>
            <SelectItem value="page">page</SelectItem>
            <SelectItem value="content">content</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={selfMetadata.noframes !== undefined}
          onChange={(event) =>
            onChange('noframes', event.target.checked ? [''] : undefined)
          }
        />
        {t('editor.noFrames')}
      </label>
      <label className="flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={selfMetadata.unwrap !== undefined}
          onChange={(event) =>
            onChange('unwrap', event.target.checked ? [''] : undefined)
          }
        />
        {t('editor.unwrap')}
      </label>
      <label className="flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={selfMetadata['top-level-await'] !== undefined}
          onChange={(event) =>
            onChange('top-level-await', event.target.checked ? [''] : undefined)
          }
        />
        {t('editor.topLevelAwait')}
      </label>
      <FieldText
        label={t('editor.updateUrl')}
        value={selfMetadata.updateurl?.[0] ?? ''}
        onChange={(value) => onChange('updateurl', value.trim() ? [value.trim()] : undefined)}
        placeholder={getMeta(metadata, 'updateurl') ?? ''}
      />
      <FieldText
        label={t('editor.downloadUrl')}
        value={selfMetadata.downloadurl?.[0] ?? ''}
        onChange={(value) => onChange('downloadurl', value.trim() ? [value.trim()] : undefined)}
        placeholder={getMeta(metadata, 'downloadurl') ?? ''}
      />
      <FieldText
        label={t('editor.storageName')}
        value={selfMetadata.storagename?.[0] ?? ''}
        onChange={(value) => onChange('storagename', value.trim() ? [value.trim()] : undefined)}
        placeholder={getMeta(metadata, 'storagename') ?? ''}
      />
      <div className="rounded-md border border-border bg-muted/30 p-2 text-[10px] text-muted-foreground">
        <div className="flex flex-wrap gap-1">
          {getMetaList(metadata, 'grant').map((grant) => (
            <Badge key={grant} variant="outline">
              {grant}
            </Badge>
          ))}
          {getMetaList(metadata, 'connect').map((connect) => (
            <Badge key={connect} variant="accent">
              {connect}
            </Badge>
          ))}
        </div>
      </div>
      <Button variant="outline" size="sm" className="w-full" disabled={disabled} onClick={onSave}>
        {t('editor.saveMetadata')}
      </Button>
    </div>
  );
}

function FieldText({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px]">{label}</Label>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-h-14 text-xs"
        spellCheck={false}
      />
    </div>
  );
}
