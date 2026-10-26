import { toErrorMessage } from '@greenhouse/utils/error';
/** Read-only deployment inventory. Enabling plugins requires configuration and restart. */
import React, { useMemo, useState } from 'react';
import type { PluginHostStatus } from '@greenhouse/types/plugin-host';
import { CrudPage, defineCrud, type CrudDataSource } from '../settings/crud';
import { ModulePage } from '../../components/app/module-page';
import { EmptyState, Tag } from '../../components/ui';
import { Plug, RefreshCw } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { fetchPluginStatus } from '../../lib/api/plugins';

export function PluginsPanel() {
  const t = useT();
  const [loadError, setLoadError] = useState<string | null>(null);
  const dataSource = useMemo<CrudDataSource<PluginHostStatus>>(
    () => ({
      async list({ skip = 0, limit = 20 }) {
        try {
          const rows = await fetchPluginStatus();
          setLoadError(null);
          return { items: rows.slice(skip, skip + limit), total: rows.length };
        } catch (error) {
          setLoadError(toErrorMessage(error));
          throw error;
        }
      },
    }),
    [],
  );
  const schema = useMemo(
    () =>
      defineCrud<PluginHostStatus>({
        name: t('plugins.title'),
        icon: Plug,
        testId: 'admin-plugins',
        storageKey: 'admin.plugins',
        dataSource,
        access: { canView: true },
        emptyMessage: t('plugins.empty'),
        pageActions: [{ key: 'refresh', label: t('common.refresh'), icon: RefreshCw, onClick: (ctx) => ctx.reload() }],
        slots: {
          empty: loadError ? (
            <EmptyState icon={Plug} tone="danger" title={t('plugins.loadFailed')} description={loadError} />
          ) : undefined,
        },
        columns: [
          { key: 'name', label: t('plugins.name') },
          { key: 'id', label: t('plugins.id') },
          {
            key: 'compiled',
            label: t('plugins.compiled'),
            type: 'custom',
            render: (row) => t(row.compiled ? 'common.yes' : 'common.no'),
          },
          {
            key: 'enabled',
            label: t('plugins.enabled'),
            type: 'custom',
            render: (row) => (
              <Tag tone={row.enabled ? 'success' : 'neutral'}>{t(row.enabled ? 'plugins.on' : 'plugins.off')}</Tag>
            ),
          },
          { key: 'version', label: t('plugins.version') },
          { key: 'sdk', label: t('plugins.sdk'), type: 'number' },
          {
            key: 'migrationState',
            label: t('plugins.migrations'),
            type: 'custom',
            render: (row) => (
              <Tag
                tone={
                  row.migrationState === 'error' ? 'danger' : row.migrationState === 'pending' ? 'warning' : 'neutral'
                }
              >
                {t(`plugins.migration.${row.migrationState}`)}
              </Tag>
            ),
          },
          {
            key: 'bootState',
            label: t('plugins.boot'),
            type: 'custom',
            render: (row) => t(`plugins.bootState.${row.bootState}`),
          },
          { key: 'dependsOn', label: t('plugins.dependsOn'), type: 'tags' },
          {
            key: 'errors',
            label: t('plugins.errors'),
            type: 'custom',
            render: (row) => {
              const errors = [...row.bootErrors, ...(row.migrationError ? [row.migrationError] : [])].join('; ');
              return (
                <span className="block max-w-64 truncate" title={errors}>
                  {errors || '—'}
                </span>
              );
            },
          },
        ],
        detailTabs: [
          {
            key: 'migrations',
            label: t('plugins.migrations'),
            kind: 'custom',
            render: (row) => (
              <ul className="space-y-2 text-sm">
                {row.migrations.map((file) => (
                  <li key={file.name}>
                    {file.name} — {t(`plugins.fileState.${file.state}`)}
                    {file.drifted ? ` · ${t('plugins.drifted')}` : ''}
                  </li>
                ))}
              </ul>
            ),
          },
        ],
      }),
    [t, dataSource, loadError],
  );
  return (
    <ModulePage
      moduleId="admin.plugins"
      layout="list"
      notice={<p className="text-xs text-fg-muted">{t('plugins.notice')}</p>}
    >
      <div data-testid="admin-plugins">
        <CrudPage schema={schema} />
      </div>
    </ModulePage>
  );
}
