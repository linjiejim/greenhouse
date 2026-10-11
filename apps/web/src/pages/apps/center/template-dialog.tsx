/**
 * "From a template": the built-in templates the server offers
 * (`GET /api/apps/templates`); installing one creates a new Base the caller
 * owns with the template's tables and a draft app on it, then opens the
 * builder. Install is not idempotent (every call builds another Base), so
 * while one runs every button is disabled and the dialog cannot be closed —
 * closing would unmount the guard and let a second install start. The center
 * only shows this entry to Tables members when the server lists templates.
 */

import { useState } from 'react';
import type { AppTemplateSummary } from '@greenhouse/types/apps';
import { AppBadge } from '../../../components/apps';
import { FormError } from '../../../components/form';
import { Button, Dialog } from '../../../components/ui';
import { installAppTemplate } from '../../../lib/api/apps';
import { appBuilderHref } from '../../../lib/app-routes';
import { useT } from '../../../lib/i18n';
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

  const install = async (template: AppTemplateSummary) => {
    if (installing) return;
    setInstalling(template.key);
    setError('');
    try {
      const result = await installAppTemplate(template.key);
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
      size="lg"
    >
      <div className="space-y-4" data-testid="template-dialog">
        <p className="text-xs text-fg-muted">{t('apps.center.templates.note')}</p>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {templates.map((template) => (
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
              <Button
                size="sm"
                className="min-h-11 self-end md:min-h-0"
                disabled={installing !== null}
                onClick={() => void install(template)}
                data-testid={`template-${template.key}-install`}
              >
                {installing === template.key ? t('apps.center.templates.installing') : t('apps.center.templates.use')}
              </Button>
            </li>
          ))}
        </ul>
        <FormError>{error}</FormError>
      </div>
    </Dialog>
  );
}
