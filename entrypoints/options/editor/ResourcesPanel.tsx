import { useTranslation } from 'react-i18next';
import { PackageOpen } from 'lucide-react';
import type { StoredResource } from '@/types';
import { formatBytes } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/layout/EmptyState';
import { SettingsGroup } from '@/components/settings/SettingsGroup';

/**
 * Resources cached for one script.
 *
 * Read-only by design: `@require` / `@require-css` / `@resource` are part of the
 * script's contract, so the only way to change them is to edit the metadata
 * block. Offering an editor here would create a second, invisible source of
 * truth.
 */
export function ResourcesPanel({ resources }: { resources: StoredResource[] }) {
  const { t } = useTranslation();

  return (
    <SettingsGroup title={t('editor.groupResources')} description={t('editor.resourcesHint')}>
      {resources.length === 0 ? (
        <EmptyState
          icon={PackageOpen}
          title={t('editor.emptyResources')}
          description={t('editor.emptyResourcesDescription')}
          className="py-8"
        />
      ) : (
        resources.map((resource) => (
          <div key={`${resource.uuid}:${resource.url}`} className="py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Badge variant="outline" className="font-mono">
                {resource.kind}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {resource.name}
              </span>
              <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                {formatBytes((resource.content?.length ?? 0) + (resource.base64?.length ?? 0))}
              </span>
            </div>
            <p className="mt-1 break-all font-mono text-2xs leading-relaxed text-muted-foreground">
              {resource.url}
            </p>
          </div>
        ))
      )}
    </SettingsGroup>
  );
}
