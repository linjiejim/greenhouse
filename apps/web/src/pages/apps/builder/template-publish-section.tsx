import { useState } from 'react';
import type { AppSummary, AppTemplatePublishInput } from '@greenhouse/types/apps';
import { Button, Input, Textarea } from '../../../components/ui';
import { FormError, FormField } from '../../../components/form';
import { publishAppTemplate } from '../../../lib/api/app-templates';
import { useT } from '../../../lib/i18n';
import { TemplateDetailDialog } from '../center/template-detail-dialog';
import { PanelSection } from './properties/common';

export function TemplatePublishSection({ app }: { app: AppSummary }) {
  const t = useT();
  const [key, setKey] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [changelog, setChangelog] = useState('');
  const [samples, setSamples] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [published, setPublished] = useState('');
  const publish = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const sampleRecords: unknown = samples.trim() ? JSON.parse(samples) : undefined;
      if (sampleRecords !== undefined && !Array.isArray(sampleRecords))
        throw new Error(t('apps.templates.invalidSamples'));
      const result = await publishAppTemplate({
        appId: app.id,
        key: key.trim(),
        version,
        changelog,
        name: app.name,
        description: app.description ?? '',
        sampleRecords: sampleRecords as AppTemplatePublishInput['sampleRecords'],
      });
      setPublished(result.template.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PanelSection
      title={t('apps.templates.save')}
      hint={t('apps.templates.saveHint')}
      defaultOpen={false}
      testId="app-template-publish-section"
    >
      <FormField label={t('apps.templates.key')}>
        <Input value={key} maxLength={40} onChange={(e) => setKey(e.target.value)} data-testid="template-publish-key" />
      </FormField>
      <FormField label={t('apps.templates.version')}>
        <Input value={version} onChange={(e) => setVersion(e.target.value)} />
      </FormField>
      <FormField label={t('apps.templates.changelog')}>
        <Textarea value={changelog} maxLength={2000} rows={2} onChange={(e) => setChangelog(e.target.value)} />
      </FormField>
      <details>
        <summary className="cursor-pointer text-sm">{t('apps.templates.samples')}</summary>
        <p className="my-2 text-xs text-fg-muted">{t('apps.templates.samplesHint')}</p>
        <Textarea
          aria-label={t('apps.templates.samples')}
          value={samples}
          rows={5}
          onChange={(e) => setSamples(e.target.value)}
          placeholder={'[{"tableId": 1, "values": [{"fieldId": 1, "value": "Example"}]}]'}
        />
      </details>
      <FormError>{error}</FormError>
      <Button
        variant="outline"
        disabled={busy || !key.trim() || !version}
        onClick={() => void publish()}
        data-testid="template-publish"
      >
        {t('apps.templates.publish')}
      </Button>
      {published && <TemplateDetailDialog templateKey={published} onClose={() => setPublished('')} />}
    </PanelSection>
  );
}
