import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Save } from 'lucide-react';
import type { ScriptMetadata, ScriptVersion, StoredResource, UserScript } from '@/types';
import { sendBg } from '@/lib/messages';
import { isMacPlatform } from '@/lib/utils';
import { parseMetadata } from '@/lib/script/metadata';
import { newScriptTemplate } from '@/lib/script/template';
import { CodeEditor } from '@/components/editor/CodeEditor';
import { SectionNav } from '@/components/layout/SectionNav';
import { PageLayout } from '@/components/layout/PageLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { MetadataPanel } from './editor/MetadataPanel';
import { ValuesPanel } from './editor/ValuesPanel';
import { ResourcesPanel } from './editor/ResourcesPanel';
import { InfoPanel, InfoPanelEmpty } from './editor/InfoPanel';

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

/** Order-sensitive comparison of two override maps. */
function sameMetadata(a: ScriptMetadata, b: ScriptMetadata): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    // An empty array is a real override ("remove this tag"), so presence has to
    // be compared before contents.
    if ((left === undefined) !== (right === undefined)) return false;
    if (!left || !right) continue;
    if (left.length !== right.length) return false;
    if (left.some((value, index) => value !== right[index])) return false;
  }
  return true;
}

/**
 * Script editor.
 *
 * Layout: the code panel owns every pixel the window can give it, so the page
 * frame is `full` width and the editor is flush — no card, no padding. The
 * metadata/values/resources/info panels are forms and constrain themselves to
 * `max-w-3xl` instead of shrinking the frame, which keeps the header and the tab
 * strip from jumping sideways when the user switches tabs.
 *
 * The two saves stay separate because they write different records: `Save`
 * rewrites the script source, `Save overrides` patches the override map. Only
 * the override action is tab-scoped, and it stays disabled until something is
 * actually overridden.
 *
 * `Mod+S` follows the same rule: it always triggers whichever primary save is
 * on screen at that moment (overrides while the metadata tab has unsaved
 * overrides, the script otherwise), so the keyboard does exactly what the
 * highlighted button promises.
 */
export function EditorPage({ uuid, initialPanel, onBack, onSaved }: EditorPageProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const isNew = !uuid || uuid === 'new';
  const [code, setCode] = useState(() => newScriptTemplate());
  const [originalCode, setOriginalCode] = useState('');
  const [script, setScript] = useState<(UserScript & { code: string }) | null>(null);
  const [selfMetadata, setSelfMetadata] = useState<ScriptMetadata>({});
  const [savedSelfMetadata, setSavedSelfMetadata] = useState<ScriptMetadata>({});
  const [resources, setResources] = useState<StoredResource[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [tab, setTab] = useState<Tab>(() => (isTab(initialPanel) ? initialPanel : 'code'));
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const parsed = useMemo(() => parseMetadata(code), [code]);
  const codeDirty = code !== originalCode;
  const overridesDirty = !sameMetadata(selfMetadata, savedSelfMetadata);
  const unsaved = codeDirty || overridesDirty;

  const load = useCallback(async () => {
    if (isNew || !uuid) {
      const template = newScriptTemplate();
      setCode(template);
      setOriginalCode(template);
      setScript(null);
      setSelfMetadata({});
      setSavedSelfMetadata({});
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
      setSavedSelfMetadata(detail.script.selfMetadata ?? {});
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
    if (!unsaved) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [unsaved]);

  const save = async () => {
    // While an existing record is still loading there is no identity to save
    // against; a save here would silently create a duplicate script.
    if (loading || (!isNew && !script)) return;
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
        selfMetadata,
      });
      setScript({ ...next, code });
      setSavedSelfMetadata(selfMetadata);
      toast({ title: t('editor.metadataSaved'), variant: 'success' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const addValue = async (key: string, value: unknown) => {
    if (!script) return;
    try {
      await sendBg('values:set', { uuid: script.uuid, key, value });
      setValues((prev) => ({ ...prev, [key]: value }));
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

  // The save the shortcut should fire right now. `metadata` with dirty
  // overrides is the only state where the primary button is not `Save`.
  const overrideIsPrimary = tab === 'metadata' && overridesDirty;

  // Rebuilt on every commit so the listener never reads a stale closure. The
  // listener itself is installed once: the gesture is global to the page, and
  // CodeMirror does not bind `Mod-s`, so it bubbles here untouched.
  const shortcutSave = useRef<() => void>(() => undefined);
  useEffect(() => {
    shortcutSave.current = () => {
      if (loading || saving || confirmDiscard) return;
      if (overrideIsPrimary) void saveOverrides();
      else void save();
    };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // `Mod+Shift+S` is the browser's "save page as"; leave it alone.
      if (event.altKey || event.shiftKey) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      shortcutSave.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const saveShortcutLabel = isMacPlatform() ? '\u2318S' : 'Ctrl+S';

  const requestBack = () => {
    if (unsaved) {
      setConfirmDiscard(true);
      return;
    }
    onBack();
  };

  if (loading) {
    return (
      <PageLayout
        width="full"
        className="h-full min-h-0"
        header={<Skeleton className="h-8 w-64" />}
        contentClassName="space-y-4"
      >
        <Skeleton className="h-8 w-72" />
        <Skeleton className="min-h-64 flex-1 rounded-card" />
      </PageLayout>
    );
  }

  const isCode = tab === 'code';

  return (
    <PageLayout
      width="full"
      className="h-full min-h-0"
      contentClassName="flex min-h-0 flex-1 flex-col p-0 sm:p-0"
      header={
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Button variant="ghost" size="iconSm" onClick={requestBack} aria-label={t('editor.back')}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <h1 className="min-w-0 truncate text-sm font-semibold text-foreground">
                    {script?.name ?? t('editor.newTitle')}
                  </h1>
                  {unsaved && <Badge variant="warning">{t('editor.unsaved')}</Badge>}
                </div>
                <p className="min-w-0 truncate text-2xs text-muted-foreground">
                  {script?.namespace || t('scripts.noSource')}
                  {script?.version ? ` · v${script.version}` : ''}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {tab === 'metadata' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void saveOverrides()}
                      disabled={!script || saving || !overridesDirty}
                    >
                      {t('editor.saveMetadata')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="flex items-center gap-1.5">
                    {t('editor.saveMetadata')}
                    <Kbd>{saveShortcutLabel}</Kbd>
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" onClick={() => void save()} disabled={saving}>
                    <Save className="h-3.5 w-3.5" />
                    {saving ? t('editor.saving') : t('editor.save')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="flex items-center gap-1.5">
                  {t('editor.save')}
                  <Kbd>{saveShortcutLabel}</Kbd>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <SectionNav
            ariaLabel={t('editor.title')}
            value={tab}
            onChange={setTab}
            className="-mb-3.5"
            items={TAB_IDS.map((item) => ({
              value: item,
              label: t(item === 'code' ? 'editor.code' : `editor.${item}`),
            }))}
          />
        </div>
      }
    >
      {(error || parsed.errors.length > 0) && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/5 px-5 py-2 sm:px-7"
        >
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive">
            {error ?? parsed.errors.join('\n')}
          </p>
          <Button variant="ghost" size="xs" onClick={() => setError(null)}>
            {t('common.close')}
          </Button>
        </div>
      )}

      {isCode ? (
        <div className="min-h-0 flex-1 overflow-hidden bg-code-bg">
          <CodeEditor value={code} onChange={setCode} className="h-full" />
        </div>
      ) : (
        <div className="scrollbar-lumo min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          <div className="w-full max-w-3xl">
            {tab === 'metadata' && (
              <MetadataPanel
                metadata={parsed.metadata}
                selfMetadata={selfMetadata}
                onChange={updateOverride}
              />
            )}
            {tab === 'values' && (
              <ValuesPanel values={values} onAdd={addValue} onDelete={deleteValue} />
            )}
            {tab === 'resources' && <ResourcesPanel resources={resources} />}
            {tab === 'info' &&
              (script ? (
                <InfoPanel script={script} lineCount={code.split(/\r?\n/).length} />
              ) : (
                <InfoPanelEmpty />
              ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={t('editor.unsavedConfirm')}
        description={t('editor.unsavedHint')}
        confirmLabel={t('common.discard')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={onBack}
      />
    </PageLayout>
  );
}
