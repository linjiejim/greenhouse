/**
 * Data catalog (数据目录) — `#/tables/catalog`. What data the team has that
 * this member can read — Tables bases (row counts, owner, last change) and
 * extension data sources — and the MCP tool their agent reaches each one with.
 * The same list an agent gets from the `data_catalog` MCP tool (there narrowed
 * to its grant). Read-only; GET /api/data-catalog.
 */

import React, { useEffect, useState } from 'react';
import type { DataCatalog, DataCatalogReach } from '@greenhouse/types/hub-context';
import { ModulePage } from '@greenhouse/web/extension-kit';
import { Card, EmptyState, Spinner, Tag } from '@greenhouse/web/extension-kit';
import { Database, Package, Table2 } from '@greenhouse/web/extension-kit';
import { useT } from '@greenhouse/web/extension-kit';
import { formatDate } from '@greenhouse/web/extension-kit';
import { fetchDataCatalog } from '@greenhouse/web/extension-kit';

function Reach({ reach }: { reach: DataCatalogReach[] }) {
  const t = useT();
  if (reach.length === 0) return null;
  return (
    <div className="mt-3 border-t border-edge pt-3">
      <div className="mb-1.5 text-caption font-medium text-fg-secondary">{t('ext.tables.dataCatalog.reach')}</div>
      <ul className="space-y-1">
        {reach.map((entry) => (
          <li key={`${entry.tool}:${entry.how}`} className="flex flex-wrap items-baseline gap-1.5 text-xs">
            <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-caption text-fg">{entry.tool}</code>
            <Tag tone={entry.access === 'write' ? 'warning' : 'neutral'}>
              {t(`ext.tables.dataCatalog.access.${entry.access}`)}
            </Tag>
            <span className="text-caption text-fg-faint">
              {entry.group
                ? t('ext.tables.dataCatalog.scope', { group: entry.group })
                : t('ext.tables.dataCatalog.inAppOnly')}
            </span>
            <span className="basis-full text-caption leading-4 text-fg-muted">{entry.how}</span>
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
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('ext.tables.dataCatalog.loadFailed')));
  }, [t]);

  const empty = catalog !== null && catalog.bases.length === 0 && catalog.extensions.length === 0;
  return (
    <ModulePage
      moduleId="tables.catalog"
      layout="list"
      notice={
        error ? (
          <div className="rounded-sm border border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">{error}</div>
        ) : (
          <p className="text-xs text-fg-muted">{t('ext.tables.dataCatalog.intro')}</p>
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
          title={t('ext.tables.dataCatalog.emptyTitle')}
          description={t('ext.tables.dataCatalog.emptyDescription')}
        />
      ) : catalog ? (
        <div className="space-y-6" data-testid="data-catalog">
          {catalog.bases.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-fg">{t('ext.tables.dataCatalog.basesTitle')}</h2>
              {catalog.truncated && (
                <p className="text-xs text-fg-muted">
                  {t('ext.tables.dataCatalog.truncated', { count: catalog.bases.length })}
                </p>
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
                      <Tag tone="neutral">{t(`ext.tables.tables.home.role.${base.role}`)}</Tag>
                    </div>
                    {base.description && (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">{base.description}</p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-caption text-fg-faint">
                      <span>
                        {base.visibility === 'team'
                          ? t('ext.tables.tables.home.teamVisible')
                          : t('ext.tables.tables.home.private')}
                      </span>
                      {base.owner && <span>{t('ext.tables.dataCatalog.owner', { name: base.owner.name })}</span>}
                      {base.last_changed_at && (
                        <span>
                          {t('ext.tables.dataCatalog.lastChange', { date: formatDate(base.last_changed_at) })}
                        </span>
                      )}
                    </div>
                    {base.tables.length > 0 && (
                      <ul className="mt-3 divide-y divide-edge rounded-md border border-edge">
                        {base.tables.map((table) => (
                          <li key={table.id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                            <a
                              href={`${base.url}/table/${table.id}`}
                              className="min-w-0 flex-1 truncate text-fg hover:text-primary-fg"
                              title={table.name}
                            >
                              {table.name}
                            </a>
                            {table.row_count !== null && (
                              <span className="whitespace-nowrap text-fg-muted">
                                {t('ext.tables.dataCatalog.rows', { count: table.row_count })}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {base.tables_truncated && (
                      <p className="mt-2 text-caption text-fg-muted" data-testid="data-catalog-tables-truncated">
                        {t('ext.tables.dataCatalog.tablesTruncated', {
                          shown: base.tables.length,
                          total: base.table_count,
                        })}
                      </p>
                    )}
                    <Reach reach={base.reach} />
                  </Card>
                ))}
              </div>
            </section>
          )}
          {catalog.extensions.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-fg">{t('ext.tables.dataCatalog.extensionsTitle')}</h2>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {catalog.extensions.map((source) => (
                  <Card key={source.id} className="p-4" data-testid="data-catalog-extension">
                    <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                      <Package size={16} className="flex-shrink-0 text-primary-fg" />
                      <span className="truncate">{source.name}</span>
                    </div>
                    {source.description && <p className="mt-1 text-xs leading-5 text-fg-muted">{source.description}</p>}
                    {source.record_kinds.length > 0 && (
                      <p className="mt-2 text-caption text-fg-faint">
                        {t('ext.tables.dataCatalog.recordKinds', { kinds: source.record_kinds.join(', ') })}
                      </p>
                    )}
                    {source.exports.length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-caption text-fg-muted">
                        {source.exports.map((entry) => (
                          <li key={entry.type}>
                            {t('ext.tables.dataCatalog.export', { type: entry.type })} — {entry.describe}
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
