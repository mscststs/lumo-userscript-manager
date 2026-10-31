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
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { ScriptIcon } from '@/components/script/ScriptIcon';
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
  /** Display URL for the identity icon (see `ManagerScript.iconUrl`). */
  iconUrl?: string;
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
  const [iconUrl, setIconUrl] = useState<string | undefined>(undefined);
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
      setIconUrl(undefined);
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
      setIconUrl(detail.iconUrl);
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

  const tabs = (
    <SectionNav
      ariaLabel={t('editor.title')}
      value={tab}
      onChange={setTab}
      items={TAB_IDS.map((item) => ({
        value: item,
        label: t(item === 'code' ? 'editor.code' : `editor.${item}`),
      }))}
    />
  );

  if (loading) {
    // Same frame as the loaded editor — heading, tab strip, flush code surface —
    // so the page settles in place instead of growing a second header row.
    return (
      <PageLayout
        width="full"
        scroll={false}
        header={
          <>
            <div className="flex min-h-14 items-center gap-2.5 py-2.5">
              <Skeleton className="h-7 w-7 rounded-md" />
              <Skeleton className="h-7 w-7 rounded-[7px]" />
              <Skeleton className="h-4 w-48" />
            </div>
            <div className="flex h-8 items-start gap-5 pt-1.5">
              {['w-8', 'w-10', 'w-8', 'w-8', 'w-8'].map((width, index) => (
                <Skeleton key={index} className={`h-3 ${width}`} />
              ))}
            </div>
          </>
        }
      >
        <div className="min-h-0 flex-1 space-y-3 bg-code-bg px-5 py-4 sm:px-7">
          {['w-2/5', 'w-3/5', 'w-1/3', 'w-1/2', 'w-2/5', 'w-1/4'].map((width, index) => (
            <Skeleton key={index} className={`h-3 ${width}`} />
          ))}
        </div>
      </PageLayout>
    );
  }

  const isCode = tab === 'code';

  return (
    <PageLayout
      width="full"
      scroll={false}
      header={
        <>
          <PageHeader
            title={script?.name ?? t('editor.newTitle')}
            leading={
              <>
                <Button
                  variant="ghost"
                  size="iconSm"
                  onClick={requestBack}
                  aria-label={t('editor.back')}
                  className="-ml-1.5"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <ScriptIcon src={iconUrl} size="md" dimmed={script ? !script.enabled : false} />
              </>
            }
            meta={
              <>
                {script?.version && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    v{script.version}
                  </span>
                )}
                {unsaved && <Badge variant="warning">{t('editor.unsaved')}</Badge>}
              </>
            }
            actions={
              <>
                {tab === 'metadata' && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
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
                    <Button onClick={() => void save()} disabled={saving}>
                      <Save className="h-3.5 w-3.5" />
                      {saving ? t('editor.saving') : t('editor.save')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="flex items-center gap-1.5">
                    {t('editor.save')}
                    <Kbd>{saveShortcutLabel}</Kbd>
                  </TooltipContent>
                </Tooltip>
              </>
            }
          />
          {tabs}
        </>
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
