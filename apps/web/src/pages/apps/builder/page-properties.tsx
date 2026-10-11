/**
 * The settings of one page: its title and icon, whether people land on it
 * first, and its filters (`TableFilterControl[]`, the same editor a dashboard
 * uses). Removing a filter also removes the card conditions that read it
 * (`$page.<id>`) — the validator refuses a reference to a missing filter.
 */

import { useMemo } from 'react';
import { APP_LIMITS, type AppSpec, type AppSpecError } from '@greenhouse/types/apps';
import type { TableField } from '../../../lib/api/tables';
import { Toggle } from '../../../components/ui';
import { useT } from '../../../lib/i18n';
import { FilterControlsEditor } from '../../tables/dashboard/filter-controls-editor';
import { AppIconPicker } from './identity-fields';
import { PanelSection, SpecErrorList, TextSetting } from './properties/common';
import { pageOwnErrors } from './spec-errors';
import { removePageFilter, setHome, updatePage, type BuilderSchema } from './spec-model';

export function PageProperties({
  spec,
  pageId,
  schema,
  errors,
  edit,
}: {
  spec: AppSpec;
  pageId: string;
  schema: BuilderSchema;
  errors: readonly AppSpecError[];
  edit: (change: (spec: AppSpec) => AppSpec) => void;
}) {
  const t = useT();
  const page = spec.pages.find((entry) => entry.id === pageId);
  const fieldsByTable = useMemo(
    () => Object.fromEntries(schema.tables.map((table) => [table.id, schema.fieldsByTable.get(table.id) ?? []])),
    [schema],
  ) as Record<number, TableField[]>;
  if (!page) return null;
  const isHome = (spec.home ?? spec.pages[0]?.id) === page.id;

  return (
    <div className="space-y-4" data-testid="app-page-properties">
      <SpecErrorList errors={pageOwnErrors(errors, page.id)} />
      <div className="space-y-3">
        <TextSetting
          required
          label={t('apps.builder.pages.title')}
          value={page.title}
          maxLength={APP_LIMITS.nameLength}
          testId="app-page-title"
          onChange={(title) =>
            title && edit((current) => updatePage(current, page.id, (entry) => ({ ...entry, title })))
          }
        />
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-fg-secondary">{t('apps.builder.pages.icon')}</p>
          <AppIconPicker
            label={t('apps.builder.pages.icon')}
            allowNone
            value={page.icon}
            onChange={(icon) =>
              edit((current) =>
                updatePage(current, page.id, (entry) => {
                  const next = { ...entry };
                  if (icon) next.icon = icon;
                  else delete next.icon;
                  return next;
                }),
              )
            }
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-fg">{t('apps.builder.pages.startHere')}</p>
            <p className="text-[11px] leading-4 text-fg-faint">{t('apps.builder.pages.startHereHint')}</p>
          </div>
          <Toggle
            size="sm"
            checked={isHome}
            disabled={isHome}
            label={t('apps.builder.pages.startHere')}
            onChange={(on) => on && edit((current) => setHome(current, page.id))}
          />
        </div>
      </div>
      <PanelSection title={t('apps.builder.pages.filters')} hint={t('apps.builder.pages.filtersHint')}>
        <div className="space-y-3" data-testid="app-page-filters">
          <FilterControlsEditor
            controls={page.filters ?? []}
            tables={schema.tables}
            fieldsByTable={fieldsByTable}
            onChange={(controls) =>
              edit((current) => {
                const kept = new Set(controls.map((control) => control.id));
                const removed = (page.filters ?? []).filter((control) => !kept.has(control.id));
                const cleaned = removed.reduce((next, control) => removePageFilter(next, page.id, control.id), current);
                return updatePage(cleaned, page.id, (entry) => {
                  const next = { ...entry };
                  if (controls.length > 0) next.filters = controls;
                  else delete next.filters;
                  return next;
                });
              })
            }
          />
        </div>
      </PanelSection>
    </div>
  );
}
