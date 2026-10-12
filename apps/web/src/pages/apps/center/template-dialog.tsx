/**
 * "From a template": the built-in templates the server offers
 * (`GET /api/apps/templates`); installing one creates a new Base the caller
 * owns with the template's tables and a draft app on it, then opens the
 * builder. Install is not idempotent (every call builds another Base), so
 * while one runs every button is disabled and the dialog cannot be closed —
 * closing would unmount the guard and let a second install start. The center
 * only shows this entry to Tables members when the server lists templates.
 */

import { useEffect, useRef, useState } from 'react';
import type { AppTemplateSummary } from '@greenhouse/types/apps';
import { AppBadge } from '../../../components/apps';
import { FormError, FormField } from '../../../components/form';
import { Button, Dialog, Input, Tag } from '../../../components/ui';
import { installAppTemplate, listAppTemplates } from '../../../lib/api/apps';
import { appBuilderHref } from '../../../lib/app-routes';
import { useT } from '../../../lib/i18n';
import { TemplateDetailDialog } from './template-detail-dialog';
import { useAppsStore } from '../../../stores/apps-store';

export function TemplateDialog({
  open,
  templates,
  onClose,
}: {
  open: boolean;
  templates: readonly AppTemplateSummary[];
  onClose: () => void;
}) {
  const t = useT();
  const reloadShelves = useAppsStore((state) => state.load);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [detailKey, setDetailKey] = useState('');
  const [newName, setNewName] = useState('');
  const [selected, setSelected] = useState<AppTemplateSummary | null>(null);
  const [catalog, setCatalog] = useState(templates);
  const restoreTemplateFocus = useRef<string | null>(null);
  const catalogElement = useRef<HTMLUListElement>(null);
  useEffect(() => setCatalog(templates), [templates]);
  useEffect(() => {
    if (!selected && restoreTemplateFocus.current) {
      const testId = `template-${restoreTemplateFocus.current}-install`;
      const button = [
        ...(catalogElement.current?.querySelectorAll<HTMLButtonElement>('button[data-testid]') ?? []),
      ].find((element) => element.dataset.testid === testId);
      button?.focus();
      restoreTemplateFocus.current = null;
    }
  }, [selected]);

  const install = async (template: AppTemplateSummary) => {
    if (installing) return;
    setInstalling(template.key);
    setError('');
    try {
      const result = newName.trim()
        ? await installAppTemplate(template.key, { name: newName.trim() })
        : await installAppTemplate(template.key);
      void reloadShelves(true);
      onClose();
      window.location.hash = appBuilderHref(result.app.id);
    } catch (installError) {
      setError(
        installError instanceof Error && installError.message
          ? installError.message
          : t('apps.center.templates.failed'),
      );
    } finally {
      setInstalling(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!installing) onClose();
      }}
      title={t('apps.center.templates.title')}
      size={selected ? 'md' : 'lg'}
    >
      <div className="space-y-4" data-testid="template-dialog">
        {selected ? (
          <>
            <div className="flex items-center gap-3">
              <AppBadge icon={selected.icon} accent={selected.accent} />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-fg">{selected.name}</h3>
                <p className="text-xs text-fg-muted">{selected.description}</p>
              </div>
            </div>
            <FormField label={t('apps.templates.newName')}>
              <Input
                autoFocus
                value={newName}
                placeholder={selected.name}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={60}
                disabled={installing !== null}
                data-testid="template-new-name"
              />
            </FormField>
            <p className="text-xs text-fg-muted">{t('apps.center.templates.note')}</p>
            <div className="flex justify-between gap-2 border-t border-edge pt-4">
              <Button
                variant="ghost"
                disabled={installing !== null}
                onClick={() => {
                  restoreTemplateFocus.current = selected.key;
                  setSelected(null);
                  setError('');
                }}
                data-testid="template-back"
              >
                {t('apps.center.templates.back')}
              </Button>
              <Button
                disabled={installing !== null}
                onClick={() => void install(selected)}
                data-testid="template-create"
              >
                {installing ? t('apps.center.templates.installing') : t('apps.center.newApp')}
              </Button>
            </div>
          </>
        ) : (
          <ul ref={catalogElement} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {catalog.map((template) => (
              <li
                key={template.key}
                className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-card p-4"
                data-testid={`template-${template.key}`}
              >
                <div className="flex items-start gap-3">
                  <AppBadge icon={template.icon} accent={template.accent} />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-fg" title={template.name}>
                      {template.name}
                    </h3>
                    <p className="mt-1 line-clamp-3 text-xs text-fg-muted">{template.description}</p>
                  </div>
                </div>
                {(template.reviewStatus === 'pending' || template.reviewStatus === 'rejected') && (
                  <Tag tone="warning">{t(`apps.templates.status.${template.reviewStatus}`)}</Tag>
                )}
                <div className="mt-auto flex items-center justify-between gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={installing !== null}
                    onClick={() => setDetailKey(template.key)}
                  >
                    {t('apps.templates.details')}
                  </Button>
                  <Button
                    size="sm"
                    className="min-h-11 self-end md:min-h-0"
                    disabled={
                      installing !== null || template.reviewStatus === 'pending' || template.reviewStatus === 'rejected'
                    }
                    onClick={() => {
                      setSelected(template);
                      setNewName('');
                      setError('');
                    }}
                    data-testid={`template-${template.key}-install`}
                  >
                    {t('apps.center.templates.use')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <FormError>{error}</FormError>
        {detailKey && (
          <TemplateDetailDialog
            templateKey={detailKey}
            onClose={() => {
              setDetailKey('');
              void listAppTemplates()
                .then(setCatalog)
                .catch(() => undefined);
            }}
          />
        )}
      </div>
    </Dialog>
  );
}
