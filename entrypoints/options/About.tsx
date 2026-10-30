import { useTranslation } from 'react-i18next';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

/** Build information. Reads the live manifest so the version can never drift. */
export function AboutPage() {
  const { t } = useTranslation();
  const version = chrome.runtime.getManifest().version;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <SettingsHeader
        title={t('options.about.title')}
        description={t('options.about.description')}
      />

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium text-foreground">{t('app.name')}</span>
          <Badge variant="accent">v{version}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t('app.tagline')}</p>

        <Separator className="my-4" />

        <dl className="space-y-3">
          <div className="flex items-start justify-between gap-6">
            <dt className="shrink-0 text-xs text-muted-foreground">
              {t('options.about.version')}
            </dt>
            <dd className="min-w-0 text-right text-xs text-foreground">{version}</dd>
          </div>
          <div className="flex items-start justify-between gap-6">
            <dt className="shrink-0 text-xs text-muted-foreground">
              {t('options.about.stack')}
            </dt>
            <dd className="min-w-0 text-right text-xs text-foreground">
              {t('options.about.stackValue')}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-6">
            <dt className="shrink-0 text-xs text-muted-foreground">
              {t('options.about.privacy')}
            </dt>
            <dd className="min-w-0 text-right text-xs text-foreground">
              {t('options.about.privacyValue')}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
