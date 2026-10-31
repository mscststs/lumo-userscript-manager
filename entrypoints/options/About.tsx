import { useTranslation } from 'react-i18next';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { REPOSITORY_URL } from '@/lib/project';
import { BrandMark } from '@/components/brand/BrandMark';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/** Build information. Reads the live manifest so the version can never drift. */
export function AboutPage({ onOpenData }: { onOpenData: () => void }) {
  const { t } = useTranslation();
  const manifest = chrome.runtime.getManifest();
  const version = manifest.version;

  return (
    <PageLayout
      header={<PageHeader title={t('options.about.title')} />}
      contentClassName="space-y-6"
      width="form"
    >
      <Card variant="elevated">
        <CardContent className="pt-4">
          <div className="flex items-start gap-4">
            <BrandMark className="h-12 w-12" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-foreground">
                  {t('app.name')}
                </h2>
                <Badge variant="accent">v{version}</Badge>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">{t('app.tagline')}</p>
              <p className="mt-3 max-w-[64ch] text-sm leading-relaxed text-muted-foreground text-pretty">
                {t('options.about.intro')}
              </p>
            </div>
          </div>

          <dl className="mt-5 grid gap-x-6 gap-y-3 border-t border-border pt-4 sm:grid-cols-2">
            <Meta label={t('options.about.version')} value={version} mono />
            <Meta label={t('options.about.privacy')} value={t('options.about.privacyValue')} />
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-3">
            <span className="text-2xs text-muted-foreground">{t('options.about.source')}</span>
            <a
              href={REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-primary hover:underline"
            >
              <span className="truncate">github.com/mscststs/lumo-userscript-manager</span>
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
            </a>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/' })}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('options.about.openExtensions')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onOpenData}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {t('options.about.manageData')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <p className="text-2xs leading-relaxed text-muted-foreground">
        {t('options.about.licenseValue')}
      </p>
    </PageLayout>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd
        className={`mt-0.5 break-words text-sm text-foreground ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}
