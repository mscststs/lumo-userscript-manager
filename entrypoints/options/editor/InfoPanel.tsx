import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Save } from 'lucide-react';
import type { UserScript } from '@/types';
import { formatBytes } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import { INJECT_INTO_OPTIONS, RUN_AT_OPTIONS } from '@/lib/script/metadata-options';
import { EnumValue } from '@/components/ui/enum';
import { EmptyState } from '@/components/layout/EmptyState';
import { SettingsGroup } from '@/components/settings/SettingsGroup';

/**
 * Read-only summary of what was saved.
 *
 * Grouped by provenance rather than by type: what the script *is*, what the
 * runtime will do with it, and where it came from. The run-at / inject-into
 * rows show the label and the raw value, because the info tab exists precisely
 * for checking the value the runtime actually received.
 */
export function InfoPanel({ script, lineCount }: { script: UserScript; lineCount: number }) {
  const { t, i18n } = useTranslation();

  const runAtOption = RUN_AT_OPTIONS.find((option) => option.value === script.runAt);
  const injectIntoOption = INJECT_INTO_OPTIONS.find(
    (option) => option.value === script.injectInto,
  );

  return (
    <div className="space-y-6">
      <SettingsGroup title={t('editor.groupIdentityInfo')}>
        <InfoRow label={t('editor.name')} value={script.name} />
        <InfoRow label={t('editor.namespace')} value={script.namespace || '—'} mono />
        <InfoRow label={t('editor.version')} value={script.version || '—'} mono />
        {script.author && <InfoRow label={t('editor.author')} value={script.author} />}
        {script.description && (
          <InfoRow label={t('editor.description')} value={script.description} />
        )}
      </SettingsGroup>

      <SettingsGroup title={t('editor.groupRuntimeInfo')}>
        <InfoRow
          label={t('editor.runAt')}
          value={
            <EnumValue
              label={runAtOption ? t(runAtOption.labelKey) : script.runAt}
              raw={script.runAt}
            />
          }
        />
        <InfoRow
          label={t('editor.injectInto')}
          value={
            <EnumValue
              label={injectIntoOption ? t(injectIntoOption.labelKey) : script.injectInto}
              raw={script.injectInto}
            />
          }
        />
        <InfoRow label={t('editor.lineCount')} value={String(lineCount)} mono />
        <InfoRow label={t('editor.codeSize')} value={formatBytes(script.codeSize)} />
        <InfoRow
          label={t('editor.lastUpdated')}
          value={formatDateTime(script.updatedAt, i18n.language)}
        />
      </SettingsGroup>

      <SettingsGroup title={t('editor.groupSourceInfo')}>
        <InfoRow label={t('editor.source')} value={script.origin || t('scripts.noSource')} mono />
        {script.homepage && <InfoRow label={t('editor.homepage')} value={script.homepage} mono />}
        {script.supportUrl && (
          <InfoRow label={t('editor.supportUrl')} value={script.supportUrl} mono />
        )}
        {script.downloadUrl && (
          <InfoRow label={t('editor.downloadUrl')} value={script.downloadUrl} mono />
        )}
        {script.updateUrl && (
          <InfoRow label={t('editor.updateUrl')} value={script.updateUrl} mono />
        )}
      </SettingsGroup>
    </div>
  );
}

/** Label left, value right; wraps instead of truncating a URL to death. */
function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          mono
            ? 'min-w-0 max-w-full break-all text-right font-mono text-2xs text-foreground'
            : 'min-w-0 max-w-full break-words text-right text-xs text-foreground'
        }
      >
        {value}
      </dd>
    </div>
  );
}

/** Empty state for a script that has not been saved yet. */
export function InfoPanelEmpty() {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t('editor.info')}>
      <EmptyState
        icon={Save}
        title={t('editor.newTitle')}
        description={t('editor.infoAfterSave')}
        className="py-8"
      />
    </SettingsGroup>
  );
}
