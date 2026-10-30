import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, Save, Trash2 } from 'lucide-react';
import type { ScriptMetadata, ScriptVersion, StoredResource, UserScript } from '@/types';
import { sendBg } from '@/lib/messages';
import { parseMetadata, getMeta, getMetaList } from '@/lib/script/metadata';
import { newScriptTemplate } from '@/lib/script/template';
import { formatBytes } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import { CodeEditor } from '@/components/editor/CodeEditor';
import { SectionNav } from '@/components/layout/SectionNav';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/layout/EmptyState';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface ScriptDetail {
  script: UserScript & { code: string };
  resources: StoredResource[];
  values: Record<string, unknown>;
  versions: ScriptVersion[];
}

interface EditorPageProps {
  uuid?: string;
  /** Tab to focus when opened from a deep link (e.g. the popup). */
  initialPanel?: string;
  onBack: () => void;
  onSaved: (uuid: string) => void;
}

type Panel = 'metadata' | 'values' | 'resources' | 'info';
type Tab = 'code' | Panel;

const PANEL_IDS: Panel[] = ['metadata', 'values', 'resources', 'info'];
const TAB_IDS: Tab[] = ['code', ...PANEL_IDS];

function isTab(value: string | undefined): value is Tab {
  return TAB_IDS.includes(value as Tab);
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

/**
 * Script editor.
 *
 * Code and metadata are **tabs**, not a split view. A 1fr + 21rem split gave
 * both sides an unusable width: the code lost 340px to a panel that was itself
 * too narrow for match patterns. Tabs give each surface the full column, and the
 * one thing an editor must never do is make code unreadable to show settings.
 */
export function EditorPage({ uuid, initialPanel, onBack, onSaved }: EditorPageProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const isNew = !uuid || uuid === 'new';
  const [code, setCode] = useState(() => newScriptTemplate());
  const [originalCode, setOriginalCode] = useState('');
  const [script, setScript] = useState<(UserScript & { code: string }) | null>(null);
  const [selfMetadata, setSelfMetadata] = useState<ScriptMetadata>({});
  const [resources, setResources] = useState<StoredResource[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [tab, setTab] = useState<Tab>(() => (isTab(initialPanel) ? initialPanel : 'code'));
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
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
    if (isTab(initialPanel)) setTab(initialPanel);
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
      toast({ title: t('editor.saved'), variant: 'success' });
      onSaved(result.uuid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveOverrides = async () => {
    if (!script) {
      setError(t('editor.saveMetadata'));
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
      toast({ title: t('editor.metadataSaved'), variant: 'success' });
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

  const updateOverride = (key: string, value: string[] | undefined) => {
    setSelfMetadata((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex h-full w-full max-w-[80rem] flex-col gap-4 p-4 sm:p-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="min-h-64 flex-1 rounded-card" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full max-w-[80rem] flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="iconSm" onClick={onBack} aria-label={t('editor.back')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <h1 className="min-w-0 truncate text-sm font-semibold text-foreground">
                {script?.name ?? t('editor.newTitle')}
              </h1>
              {dirty && <Badge variant="warning">{t('editor.unsaved')}</Badge>}
            </div>
            <p className="min-w-0 truncate text-2xs text-muted-foreground">
              {script?.namespace || t('scripts.noSource')}
              {script?.version ? ` · v${script.version}` : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            <Save className="h-3.5 w-3.5" />
            {saving ? t('editor.saving') : t('editor.save')}
          </Button>
        </div>
      </header>

      <div className="shrink-0 border-y border-border px-4 sm:px-6">
        <SectionNav
          ariaLabel={t('editor.title')}
          value={tab}
          onChange={setTab}
          items={TAB_IDS.map((item) => ({
            value: item,
            label: t(item === 'code' ? 'editor.code' : `editor.${item}`),
          }))}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-lumo p-4 sm:p-6">
        {(error || parsed.errors.length > 0) && (
          <div
            role="alert"
            className="mb-3 flex items-start gap-2 rounded-card border border-destructive/30 bg-destructive/5 px-3 py-2"
          >
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive">
              {error ?? parsed.errors.join('\n')}
            </p>
            <Button variant="ghost" size="xs" onClick={() => setError(null)}>
              {t('common.close')}
            </Button>
          </div>
        )}

        {tab === 'code' ? (
          <div className="h-full min-h-[360px] overflow-hidden rounded-card border border-border bg-code-bg">
            <CodeEditor value={code} onChange={setCode} className="h-full" />
          </div>
        ) : (
          <div className="max-w-3xl">
            <Card>
              <CardContent className="pt-4">
                {tab === 'metadata' && (
                  <MetadataPanel
                    metadata={parsed.metadata}
                    selfMetadata={selfMetadata}
                    onChange={updateOverride}
                    onSave={() => void saveOverrides()}
                    disabled={!script}
                    saving={saving}
                  />
                )}

                {tab === 'values' && (
                  <div className="space-y-3">
                    {Object.keys(values).length === 0 ? (
                      <p className="py-8 text-center text-xs text-muted-foreground">
                        {t('editor.emptyValues')}
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {Object.entries(values).map(([key, value]) => (
                          <div key={key} className="rounded-control border border-border p-2">
                            <div className="flex items-center justify-between gap-2">
                              <code className="min-w-0 truncate font-mono text-xs font-medium text-foreground">
                                {key}
                              </code>
                              <Button
                                variant="ghost"
                                size="iconSm"
                                onClick={() => void deleteValue(key)}
                                aria-label={t('editor.deleteValue')}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs text-muted-foreground">
                              {JSON.stringify(value, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                    <Separator />
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
                      <Input
                        value={newKey}
                        onChange={(event) => setNewKey(event.target.value)}
                        placeholder={t('editor.key')}
                        className="font-mono"
                      />
                      <Textarea
                        value={newValue}
                        onChange={(event) => setNewValue(event.target.value)}
                        placeholder={t('editor.value')}
                        className="min-h-16 font-mono"
                      />
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void addValue()}>
                      <Plus className="h-3.5 w-3.5" />
                      {t('editor.addValue')}
                    </Button>
                  </div>
                )}

                {tab === 'resources' && (
                  <div className="space-y-1.5">
                    {resources.length === 0 ? (
                      <p className="py-8 text-center text-xs text-muted-foreground">
                        {t('editor.emptyResources')}
                      </p>
                    ) : (
                      resources.map((resource) => (
                        <div
                          key={`${resource.uuid}:${resource.url}`}
                          className="rounded-control border border-border p-2"
                        >
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline">{resource.kind}</Badge>
                            <span className="truncate text-xs font-medium">{resource.name}</span>
                          </div>
                          <p className="mt-1 break-all font-mono text-2xs text-muted-foreground">
                            {resource.url}
                          </p>
                          <p className="text-2xs tabular-nums text-muted-foreground">
                            {formatBytes(
                              (resource.content?.length ?? 0) + (resource.base64?.length ?? 0),
                            )}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {tab === 'info' &&
                  (script ? (
                    <dl className="space-y-2.5 text-xs">
                      <InfoRow label={t('editor.name')} value={script.name} />
                      <InfoRow label={t('editor.namespace')} value={script.namespace || '—'} />
                      <InfoRow label={t('editor.version')} value={script.version || '—'} mono />
                      <InfoRow
                        label={t('editor.source')}
                        value={script.origin || t('scripts.noSource')}
                      />
                      {script.homepage && (
                        <InfoRow label={t('editor.homepage')} value={script.homepage} />
                      )}
                      {script.supportUrl && (
                        <InfoRow label={t('editor.supportUrl')} value={script.supportUrl} />
                      )}
                      <InfoRow label={t('editor.codeSize')} value={formatBytes(script.codeSize)} />
                      <InfoRow
                        label={t('editor.lastUpdated')}
                        value={formatDateTime(script.updatedAt, i18n.language)}
                      />
                      <InfoRow label={t('editor.runAt')} value={script.runAt} mono />
                      <InfoRow label={t('editor.injectInto')} value={script.injectInto} mono />
                      <InfoRow
                        label={t('editor.lines')}
                        value={String(code.split(/\r?\n/).length)}
                      />
                    </dl>
                  ) : (
                    <EmptyState
                      icon={Save}
                      title={t('editor.newTitle')}
                      description={t('editor.infoAfterSave')}
                      className="py-8"
                    />
                  ))}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={`min-w-0 break-all text-right text-foreground ${mono ? 'font-mono text-2xs' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}

function MetadataPanel({
  metadata,
  selfMetadata,
  onChange,
  onSave,
  disabled,
  saving,
}: {
  metadata: ScriptMetadata;
  selfMetadata: ScriptMetadata;
  onChange: (key: string, value: string[] | undefined) => void;
  onSave: () => void;
  disabled: boolean;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const merged = { ...metadata, ...selfMetadata };

  return (
    <div className="space-y-4">
      <p className="text-2xs leading-relaxed text-muted-foreground">{t('editor.overridesHint')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <FieldText
          label={t('editor.match')}
          value={metaToLines(merged, 'match')}
          onChange={(value) => onChange('match', linesToMeta('match', value))}
          placeholder={metaToLines(metadata, 'match')}
        />
        <FieldText
          label={t('editor.include')}
          value={metaToLines(merged, 'include')}
          onChange={(value) => onChange('include', linesToMeta('include', value))}
          placeholder={metaToLines(metadata, 'include')}
        />
        <FieldText
          label={t('editor.exclude')}
          value={metaToLines(merged, 'exclude')}
          onChange={(value) => onChange('exclude', linesToMeta('exclude', value))}
          placeholder={metaToLines(metadata, 'exclude')}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t('editor.runAt')}</Label>
          <Select
            value={selfMetadata['run-at']?.[0] ?? 'inherit'}
            onValueChange={(value) =>
              onChange('run-at', value === 'inherit' ? undefined : [value])
            }
          >
            <SelectTrigger className="text-xs">
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
          <Label className="text-xs text-muted-foreground">{t('editor.injectInto')}</Label>
          <Select
            value={selfMetadata['inject-into']?.[0] ?? 'inherit'}
            onValueChange={(value) =>
              onChange('inject-into', value === 'inherit' ? undefined : [value])
            }
          >
            <SelectTrigger className="text-xs">
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
      </div>

      <div className="grid gap-1.5 rounded-control border border-border p-2 sm:grid-cols-3">
        <ToggleLine
          label={t('editor.noFrames')}
          checked={selfMetadata.noframes !== undefined}
          onChange={(checked) => onChange('noframes', checked ? [''] : undefined)}
        />
        <ToggleLine
          label={t('editor.unwrap')}
          checked={selfMetadata.unwrap !== undefined}
          onChange={(checked) => onChange('unwrap', checked ? [''] : undefined)}
        />
        <ToggleLine
          label={t('editor.topLevelAwait')}
          checked={selfMetadata['top-level-await'] !== undefined}
          onChange={(checked) => onChange('top-level-await', checked ? [''] : undefined)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <FieldText
          label={t('editor.updateUrl')}
          value={selfMetadata.updateurl?.[0] ?? ''}
          onChange={(value) => onChange('updateurl', value.trim() ? [value.trim()] : undefined)}
          placeholder={getMeta(metadata, 'updateurl') ?? ''}
        />
        <FieldText
          label={t('editor.downloadUrl')}
          value={selfMetadata.downloadurl?.[0] ?? ''}
          onChange={(value) =>
            onChange('downloadurl', value.trim() ? [value.trim()] : undefined)
          }
          placeholder={getMeta(metadata, 'downloadurl') ?? ''}
        />
        <FieldText
          label={t('editor.storageName')}
          value={selfMetadata.storagename?.[0] ?? ''}
          onChange={(value) =>
            onChange('storagename', value.trim() ? [value.trim()] : undefined)
          }
          placeholder={getMeta(metadata, 'storagename') ?? ''}
        />
      </div>

      <div className="rounded-control border border-border bg-muted/40 p-2.5">
        <p className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('editor.grant')}
        </p>
        <div className="flex flex-wrap gap-1">
          {getMetaList(metadata, 'grant').length === 0 ? (
            <span className="text-2xs text-muted-foreground">{t('install.noPermissions')}</span>
          ) : (
            getMetaList(metadata, 'grant').map((grant) => (
              <Badge key={grant} variant="outline" className="font-mono">
                {grant}
              </Badge>
            ))
          )}
        </div>
        {getMetaList(metadata, 'connect').length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {getMetaList(metadata, 'connect').map((connect) => (
              <Badge key={connect} variant="accent" className="font-mono">
                {connect}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={disabled || saving} onClick={onSave}>
          {t('editor.saveMetadata')}
        </Button>
      </div>
    </div>
  );
}

function ToggleLine({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 accent-[var(--color-primary)]"
      />
      <span className="min-w-0 truncate">{label}</span>
    </label>
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
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-h-14 font-mono text-xs"
        spellCheck={false}
      />
    </div>
  );
}
