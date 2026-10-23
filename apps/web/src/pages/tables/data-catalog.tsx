/**
 * Data catalog (数据目录) — `#/tables/catalog`. What data the team has that
 * this member can read — Tables bases (row counts, owner, last change) and
 * extension data sources — and the MCP tool their agent reaches each one with.
 * The same list an agent gets from the `data_catalog` MCP tool (there narrowed
 * to its grant). Read-only; GET /api/data-catalog.
 */

import React, { useEffect, useState } from 'react';
import type { DataCatalog, DataCatalogReach } from '@greenhouse/types/hub-context';
import { ModulePage } from '../../components/app/module-page';
import { Card, EmptyState, Spinner, Tag } from '../../components/ui';
import { Database, Package, Table2 } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { formatDate } from '../../lib/utils';
import { fetchDataCatalog } from '../../lib/api/hub-context';

function Reach({ reach }: { reach: DataCatalogReach[] }) {
  const t = useT();
  if (reach.length === 0) return null;
  return (
    <div className="mt-3 border-t border-edge pt-3">
      <div className="mb-1.5 text-[11px] font-medium text-fg-secondary">{t('dataCatalog.reach')}</div>
      <ul className="space-y-1">
        {reach.map((entry) => (
          <li key={`${entry.tool}:${entry.how}`} className="flex flex-wrap items-baseline gap-1.5 text-xs">
            <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-fg">{entry.tool}</code>
            <Tag tone={entry.access === 'write' ? 'warning' : 'neutral'}>{t(`dataCatalog.access.${entry.access}`)}</Tag>
            <span className="text-[11px] text-fg-faint">
              {entry.group ? t('dataCatalog.scope', { group: entry.group }) : t('dataCatalog.inAppOnly')}
            </span>
            <span className="basis-full text-[11px] leading-4 text-fg-muted">{entry.how}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DataCatalogPage() {
  const t = useT();
  const [catalog, setCatalog] = useState<DataCatalog | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchDataCatalog()
      .then(setCatalog)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('dataCatalog.loadFailed')));
  }, [t]);

  const empty = catalog !== null && catalog.bases.length === 0 && catalog.extensions.length === 0;
  return (
    <ModulePage
      moduleId="workspace.data-catalog"
      layout="list"
      notice={
        error ? (
          <div className="rounded-md border border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">{error}</div>
        ) : (
          <p className="text-xs text-fg-muted">{t('dataCatalog.intro')}</p>
        )
      }
    >
      {!catalog && !error ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-6 w-6 text-fg-faint" />
        </div>
      ) : empty ? (
        <EmptyState
          icon={Database}
          title={t('dataCatalog.emptyTitle')}
          description={t('dataCatalog.emptyDescription')}
        />
      ) : catalog ? (
        <div className="space-y-6" data-testid="data-catalog">
          {catalog.bases.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-fg">{t('dataCatalog.basesTitle')}</h2>
              {catalog.truncated && (
                <p className="text-xs text-fg-muted">{t('dataCatalog.truncated', { count: catalog.bases.length })}</p>
              )}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {catalog.bases.map((base) => (
                  <Card key={base.id} className="p-4" data-testid="data-catalog-base">
                    <div className="flex items-start justify-between gap-3">
                      <a
                        href={base.url}
                        className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg hover:text-primary-fg"
                      >
                        <Table2 size={16} className="flex-shrink-0 text-primary-fg" />
                        <span className="truncate" title={base.name}>
                          {base.name}
                        </span>
                      </a>
                      <Tag tone="neutral">{t(`tables.home.role.${base.role}`)}</Tag>
                    </div>
                    {base.description && (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">{base.description}</p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-faint">
                      <span>
                        {base.visibility === 'team' ? t('tables.home.teamVisible') : t('tables.home.private')}
                      </span>
                      {base.owner && <span>{t('dataCatalog.owner', { name: base.owner.name })}</span>}
                      {base.last_changed_at && (
                        <span>{t('dataCatalog.lastChange', { date: formatDate(base.last_changed_at) })}</span>
                      )}
                    </div>
                    {base.tables.length > 0 && (
                      <ul className="mt-3 divide-y divide-edge rounded-lg border border-edge">
                        {base.tables.map((table) => (
                          <li key={table.id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                            <a
                              href={`${base.url}/table/${table.id}`}
                              className="min-w-0 flex-1 truncate text-fg hover:text-primary-fg"
                              title={table.name}
                            >
                              {table.name}
                            </a>
                            <span className="whitespace-nowrap text-fg-muted">
                              {t('dataCatalog.rows', { count: table.row_count })}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <Reach reach={base.reach} />
                  </Card>
                ))}
              </div>
            </section>
          )}
          {catalog.extensions.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-fg">{t('dataCatalog.extensionsTitle')}</h2>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {catalog.extensions.map((source) => (
                  <Card key={source.id} className="p-4" data-testid="data-catalog-extension">
                    <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                      <Package size={16} className="flex-shrink-0 text-primary-fg" />
                      <span className="truncate">{source.name}</span>
                    </div>
                    {source.description && <p className="mt-1 text-xs leading-5 text-fg-muted">{source.description}</p>}
                    {source.record_kinds.length > 0 && (
                      <p className="mt-2 text-[11px] text-fg-faint">
                        {t('dataCatalog.recordKinds', { kinds: source.record_kinds.join(', ') })}
                      </p>
                    )}
                    {source.exports.length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-[11px] text-fg-muted">
                        {source.exports.map((entry) => (
                          <li key={entry.type}>
                            {t('dataCatalog.export', { type: entry.type })} — {entry.describe}
                          </li>
                        ))}
                      </ul>
                    )}
                    <Reach reach={source.reach} />
                  </Card>
                ))}
              </div>
            </section>
          )}
        </div>
      ) : null}
    </ModulePage>
  );
}
