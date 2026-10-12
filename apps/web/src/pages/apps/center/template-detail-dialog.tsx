import { useEffect, useState } from 'react';
import type { AppTemplateDetailView } from '@greenhouse/types/apps';
import { Button, ConfirmDialog, Dialog, Select, Spinner, Tag, Textarea } from '../../../components/ui';
import { FormError, FormField } from '../../../components/form';
import { archiveAppTemplate, getAppTemplate, reviewAppTemplate } from '../../../lib/api/app-templates';
import { useT } from '../../../lib/i18n';

export function TemplateDetailDialog({ templateKey, onClose }: { templateKey: string; onClose: () => void }) {
  const t = useT();
  const [view, setView] = useState<AppTemplateDetailView | null>(null);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const selectedVersion = view?.versions.find((item) => item.version === (version || view.template.version));
  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError('');
    void getAppTemplate(templateKey, version || undefined)
      .then((data) => {
        if (!cancelled) setView(data);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [templateKey, version]);
  const act = async (decision: 'approve' | 'reject') => {
    if (!view?.review || busy) return;
    setBusy(true);
    setError('');
    try {
      await reviewAppTemplate(templateKey, view.review.version, { decision, note });
      setView(await getAppTemplate(templateKey, view.review.version));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open
        onClose={() => {
          if (!busy) onClose();
        }}
        title={view?.template.name ?? t('apps.templates.details')}
        size={view?.template.canReview ? 'workspace' : 'lg'}
      >
        <div className="space-y-4" data-testid="template-detail">
          <FormError>{error}</FormError>
          {!view && !error && (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          )}
          {view && (
            <>
              <p className="text-sm text-fg-muted">{view.template.description}</p>
              {selectedVersion && (
                <Tag
                  tone={
                    selectedVersion.reviewStatus === 'pending' || selectedVersion.reviewStatus === 'rejected'
                      ? 'warning'
                      : 'neutral'
                  }
                >
                  {t(`apps.templates.status.${selectedVersion.reviewStatus}`)}
                </Tag>
              )}
              {view.creates && (
                <ul className="text-sm">
                  {view.creates.tables.map((table, i) => (
                    <li key={i}>
                      {table.name} · {t('apps.templates.fields', { count: table.fields })}
                    </li>
                  ))}
                </ul>
              )}
              {view.versions
                .filter((item) => item.version === (version || view.template.version))
                .some((item) => item.carries.customCards > 0) && (
                <p className="text-sm text-fg-muted">{t('apps.templates.customUnavailable')}</p>
              )}
              <details className="rounded-lg border border-edge p-3">
                <summary className="cursor-pointer text-sm text-fg-muted">
                  {t('apps.templates.technical')} · {version || view.template.version}
                </summary>
                <div className="space-y-3 pt-3">
                  {view.versions.length > 1 && (
                    <FormField label={t('apps.templates.version')}>
                      <Select
                        value={version || view.template.version}
                        disabled={busy}
                        onChange={(e) => setVersion(e.target.value)}
                      >
                        {view.versions.map((item) => (
                          <option key={item.version} value={item.version}>
                            {item.version} · {t(`apps.templates.status.${item.reviewStatus}`)}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  {view.versions
                    .filter((item) => item.version === (version || view.template.version))
                    .map((item) => (
                      <div key={item.version} className="space-y-2 text-xs text-fg-muted">
                        <p>{item.changelog}</p>
                        <p className="break-all">sha256: {item.contentHash}</p>
                        <p>
                          {t('apps.templates.scan')}: {item.scanStatus}
                        </p>
                        <p>{item.reviewNote}</p>
                      </div>
                    ))}
                </div>
              </details>
              {(view.review || view.template.canManage) && (
                <details
                  key={version || view.template.version}
                  open={
                    view.template.canReview &&
                    view.versions.some(
                      (item) => item.version === (version || view.template.version) && item.reviewStatus === 'pending',
                    )
                  }
                  className="space-y-3"
                >
                  <summary className="cursor-pointer text-sm font-medium text-fg">
                    {t('apps.templates.management')}
                  </summary>
                  {view.review && (
                    <details open={view.template.canReview}>
                      <summary className="cursor-pointer text-sm">{t('apps.templates.reviewContent')}</summary>
                      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-edge p-3 text-xs">
                        {JSON.stringify(JSON.parse(view.review.content), null, 2)}
                      </pre>
                      <pre className="max-h-32 overflow-auto text-xs">
                        {JSON.stringify(view.review.scanFindings, null, 2)}
                      </pre>
                    </details>
                  )}
                  {view.template.canReview && view.review && (
                    <>
                      <FormField label={t('apps.templates.note')}>
                        <Textarea rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
                      </FormField>
                      <div className="flex gap-2">
                        <Button disabled={busy} onClick={() => void act('approve')} data-testid="template-approve">
                          {t('apps.templates.approve')}
                        </Button>
                        <Button variant="outline" disabled={busy} onClick={() => void act('reject')}>
                          {t('apps.templates.reject')}
                        </Button>
                      </div>
                    </>
                  )}
                  {view.template.canManage && view.template.status !== 'archived' && (
                    <Button variant="outline" disabled={busy} onClick={() => setArchiveOpen(true)}>
                      {t('apps.templates.archive')}
                    </Button>
                  )}
                </details>
              )}
            </>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={archiveOpen}
        title={t('apps.templates.archive')}
        description={t('apps.templates.archiveHint')}
        onClose={() => setArchiveOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            setView(await archiveAppTemplate(templateKey));
            setArchiveOpen(false);
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
