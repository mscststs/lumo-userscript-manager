import { useTranslation } from 'react-i18next';
import type { ScriptMetadata } from '@/types';
import { getMeta, getMetaList, hasMeta } from '@/lib/script/metadata';
import { INJECT_INTO_OPTIONS, RUN_AT_OPTIONS } from '@/lib/script/metadata-options';
import { Badge } from '@/components/ui/badge';
import { EnumValue } from '@/components/ui/enum';
import { FieldToggleRow } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { MetaField } from '@/components/editor/MetaField';
import { MetaTag } from '@/components/editor/MetaTag';
import { ResetOverride } from '@/components/editor/ResetOverride';
import { SettingsGroup } from '@/components/settings/SettingsGroup';

/** Sentinel for "no override" inside a `Select`, which cannot hold `undefined`. */
const INHERIT = '__inherit__';

/** Multi-line list fields: one value per line, e.g. match patterns. */
const LINE_FIELDS = [
  { key: 'match', labelKey: 'editor.match', tipKey: 'editor.matchHint', rows: 3 },
  { key: 'include', labelKey: 'editor.include', tipKey: 'editor.includeHint', rows: 2 },
  { key: 'exclude', labelKey: 'editor.exclude', tipKey: 'editor.excludeHint', rows: 2 },
  {
    key: 'exclude-match',
    labelKey: 'editor.excludeMatch',
    tipKey: 'editor.excludeMatchHint',
    rows: 2,
  },
] as const;

/** Single-value URL/name fields. */
const TEXT_FIELDS = [
  { key: 'updateurl', labelKey: 'editor.updateUrl', tipKey: 'editor.updateUrlHint' },
  { key: 'downloadurl', labelKey: 'editor.downloadUrl', tipKey: 'editor.downloadUrlHint' },
  { key: 'storagename', labelKey: 'editor.storageName', tipKey: 'editor.storageNameHint' },
] as const;

/** Bare metadata flags: presence is the value. */
const FLAG_FIELDS = [
  { key: 'noframes', labelKey: 'editor.noFrames', tipKey: 'editor.noFramesHint' },
  { key: 'unwrap', labelKey: 'editor.unwrap', tipKey: 'editor.unwrapHint' },
  {
    key: 'top-level-await',
    labelKey: 'editor.topLevelAwait',
    tipKey: 'editor.topLevelAwaitHint',
  },
] as const;

function linesOf(metadata: ScriptMetadata, key: string): string {
  return (metadata[key] ?? []).join('\n');
}

function toLines(text: string): string[] | undefined {
  const values = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

/**
 * Metadata overrides.
 *
 * Four groups, ordered by the question they answer: where does it run, how does
 * it run, where do updates come from, what is it allowed to touch. The declared
 * value is the *placeholder*, never the value — an empty control is the honest
 * representation of "no override", and it makes the reset affordance meaningful.
 */
export function MetadataPanel({
  metadata,
  selfMetadata,
  onChange,
}: {
  metadata: ScriptMetadata;
  selfMetadata: ScriptMetadata;
  onChange: (key: string, value: string[] | undefined) => void;
}) {
  const { t } = useTranslation();

  const runAt = selfMetadata['run-at']?.[0];
  const inheritedRunAt = metadata['run-at']?.[0];
  const injectInto = selfMetadata['inject-into']?.[0];
  const inheritedInjectInto = metadata['inject-into']?.[0];

  const runAtLabel = runAt
    ? t(RUN_AT_OPTIONS.find((option) => option.value === runAt)?.labelKey ?? 'editor.inherit')
    : t('editor.inherit');
  const injectIntoLabel = injectInto
    ? t(
        INJECT_INTO_OPTIONS.find((option) => option.value === injectInto)?.labelKey ??
          'editor.inherit',
      )
    : t('editor.inherit');

  return (
    <div className="space-y-6">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('editor.overridesHint')}</p>

      <SettingsGroup title={t('editor.groupScope')}>
        {LINE_FIELDS.map((field) => (
          <MetaField
            key={field.key}
            className="py-3"
            label={t(field.labelKey)}
            tag={field.key}
            tip={t(field.tipKey)}
            overridden={selfMetadata[field.key] !== undefined}
            onReset={() => onChange(field.key, undefined)}
          >
            {(props) => (
              <Textarea
                {...props}
                value={linesOf(selfMetadata, field.key)}
                onChange={(event) => onChange(field.key, toLines(event.target.value))}
                placeholder={linesOf(metadata, field.key)}
                rows={field.rows}
                spellCheck={false}
                className="min-h-0 resize-y font-mono text-xs leading-relaxed"
              />
            )}
          </MetaField>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t('editor.groupExecution')}>
        <MetaField
          className="py-3"
          label={t('editor.runAt')}
          tag="run-at"
          tip={t('editor.runAtHint')}
          overridden={runAt !== undefined}
          onReset={() => onChange('run-at', undefined)}
        >
          {(props) => (
            <Select
              value={runAt ?? INHERIT}
              onValueChange={(value) => onChange('run-at', value === INHERIT ? undefined : [value])}
            >
              <SelectTrigger {...props} className="w-full max-w-xs">
                <SelectValue>
                  <EnumValue label={runAtLabel} raw={runAt ?? inheritedRunAt} />
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>
                  <EnumValue label={t('editor.inherit')} raw={inheritedRunAt} />
                </SelectItem>
                {RUN_AT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <EnumValue label={t(option.labelKey)} raw={option.value} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </MetaField>

        <MetaField
          className="py-3"
          label={t('editor.injectInto')}
          tag="inject-into"
          tip={t('editor.injectIntoHint')}
          overridden={injectInto !== undefined}
          onReset={() => onChange('inject-into', undefined)}
        >
          {(props) => (
            <Select
              value={injectInto ?? INHERIT}
              onValueChange={(value) =>
                onChange('inject-into', value === INHERIT ? undefined : [value])
              }
            >
              <SelectTrigger {...props} className="w-full max-w-xs">
                <SelectValue>
                  <EnumValue label={injectIntoLabel} raw={injectInto ?? inheritedInjectInto} />
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>
                  <EnumValue label={t('editor.inherit')} raw={inheritedInjectInto} />
                </SelectItem>
                {INJECT_INTO_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <EnumValue label={t(option.labelKey)} raw={option.value} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </MetaField>

        {FLAG_FIELDS.map((field) => {
          // A bare flag has three states, not two: declared by the source, added
          // by an override, or removed by an override (`[]`). The switch shows
          // the effective state and writes the state that is *different* from
          // the source, so unchecking a declared flag is a real removal instead
          // of a silent no-op.
          const declared = hasMeta(metadata, field.key);
          const overridden = selfMetadata[field.key] !== undefined;
          const enabled = overridden ? hasMeta(selfMetadata, field.key) : declared;

          return (
            <FieldToggleRow
              key={field.key}
              className="py-3"
              label={t(field.labelKey)}
              labelAccessory={
                <>
                  <MetaTag tag={field.key} tip={t(field.tipKey)} />
                  {overridden && (
                    <ResetOverride onReset={() => onChange(field.key, undefined)} />
                  )}
                </>
              }
            >
              {({ id }) => (
                <Switch
                  id={id}
                  checked={enabled}
                  onCheckedChange={(checked) =>
                    onChange(field.key, checked ? [''] : declared ? [] : undefined)
                  }
                />
              )}
            </FieldToggleRow>
          );
        })}
      </SettingsGroup>

      <SettingsGroup title={t('editor.groupIdentity')}>
        {TEXT_FIELDS.map((field) => (
          <MetaField
            key={field.key}
            className="py-3"
            label={t(field.labelKey)}
            tag={field.key}
            tip={t(field.tipKey)}
            overridden={selfMetadata[field.key] !== undefined}
            onReset={() => onChange(field.key, undefined)}
          >
            {(props) => (
              <Input
                {...props}
                value={selfMetadata[field.key]?.[0] ?? ''}
                onChange={(event) =>
                  onChange(
                    field.key,
                    event.target.value.trim() ? [event.target.value.trim()] : undefined,
                  )
                }
                placeholder={getMeta(metadata, field.key) ?? ''}
                spellCheck={false}
                className="font-mono text-xs"
              />
            )}
          </MetaField>
        ))}
      </SettingsGroup>

      <SettingsGroup
        title={t('editor.groupCapabilities')}
        description={t('editor.capabilitiesHint')}
      >
        <ChipRow
          tag="grant"
          label={t('editor.grant')}
          tip={t('editor.grantHint')}
          values={getMetaList(metadata, 'grant')}
          empty={t('install.noPermissions')}
          variant="outline"
        />
        <ChipRow
          tag="connect"
          label={t('editor.connect')}
          tip={t('editor.connectHint')}
          values={getMetaList(metadata, 'connect')}
          empty={t('install.noNetwork')}
          variant="accent"
        />
      </SettingsGroup>
    </div>
  );
}

/** Read-only list of raw metadata values (grants, connect targets). */
function ChipRow({
  tag,
  label,
  tip,
  values,
  empty,
  variant,
}: {
  tag: string;
  label: string;
  tip: string;
  values: string[];
  empty: string;
  variant: 'outline' | 'accent';
}) {
  return (
    <div className="py-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <MetaTag tag={tag} tip={tip} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {values.length === 0 ? (
          <span className="text-xs text-muted-foreground">{empty}</span>
        ) : (
          values.map((value) => (
            <Badge key={value} variant={variant} className="font-mono">
              {value}
            </Badge>
          ))
        )}
      </div>
    </div>
  );
}
