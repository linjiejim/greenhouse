import React, { useEffect, useState } from 'react';
import { listTableBases, type TableBaseWithRole } from '../../lib/api/tables';
import { Button, EmptyState, SearchInput, Spinner, Tag } from '../../components/ui';
import { Plus, Table2 } from '../../lib/icons';
import { formatDay } from '../../lib/utils';
import { BaseDialog } from '../../components/tables/base-dialog';
import { useT } from '../../lib/i18n';
import { ModulePage } from '../../components/app/module-page';
import { BaseWorkspace } from './base-workspace';

interface TablesPageProps {
  subPath?: string;
  /** The route's query: `record=<id>` opens that record in the selected table. */
  params?: URLSearchParams;
}

function TablesHome() {
  const t = useT();
  const [bases, setBases] = useState<TableBaseWithRole[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      listTableBases(search)
        .then((next) => {
          if (cancelled) return;
          setBases(next);
          setError('');
        })
        .catch((loadError) => {
          if (!cancelled) setError(loadError instanceof Error ? loadError.message : t('tables.home.loadFailed'));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, t]);

  return (
    <ModulePage
      moduleId="workspace.tables"
      layout="list"
      actions={
        <Button onClick={() => setDialog(true)} size="sm">
          <Plus size={14} className="mr-1.5" />
          {t('tables.base.create')}
        </Button>
      }
      notice={
        error ? (
          <div className="rounded-md border border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">{error}</div>
        ) : undefined
      }
      toolbar={
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t('tables.home.searchPlaceholder')}
          size="sm"
          className="w-full sm:max-w-sm"
        />
      }
    >
      {loading && bases.length === 0 ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-6 w-6 text-fg-faint" />
        </div>
      ) : bases.length === 0 ? (
        <EmptyState
          icon={Table2}
          title={search ? t('tables.home.noMatchingBases') : t('tables.home.createFirstBase')}
          description={search ? t('tables.home.tryAnotherSearch') : t('tables.home.baseDescription')}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {bases.map((base) => (
            <a
              key={base.id}
              href={`#/tables/${base.id}`}
              className="group rounded-xl border border-edge bg-surface-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="rounded-lg bg-primary-subtle p-2 text-primary-fg">
                  <Table2 size={18} />
                </div>
                <Tag tone="neutral">{t(`tables.home.role.${base.role}`)}</Tag>
              </div>
              <h2
                className="mt-4 truncate text-base font-semibold text-fg group-hover:text-primary-fg"
                title={base.name}
              >
                {base.name}
              </h2>
              <p className="mt-1 line-clamp-2 min-h-10 text-xs leading-5 text-fg-muted">
                {base.description || t('tables.home.noDescription')}
              </p>
              <div className="mt-4 flex items-center justify-between border-t border-edge pt-3 text-[11px] text-fg-faint">
                <span>{base.visibility === 'team' ? t('tables.home.teamVisible') : t('tables.home.private')}</span>
                <span>{t('tables.home.updatedAt', { date: formatDay(base.updated_at) })}</span>
              </div>
            </a>
          ))}
        </div>
      )}
      <BaseDialog
        open={dialog}
        onClose={() => setDialog(false)}
        onCreated={(baseId) => {
          setDialog(false);
          window.location.hash = `#/tables/${baseId}`;
        }}
      />
    </ModulePage>
  );
}

/**
 * `#/tables` → the Base list; `#/tables/<base>[/table|dashboard/<id>][?record=<id>]` → a Base.
 * Forms live at `#/forms/<id>` (outside the Tables gate, see ./form-route).
 */
export function TablesPage({ subPath = '', params }: TablesPageProps) {
  const t = useT();
  const segments = subPath.split('/').filter(Boolean);
  if (segments.length === 0) return <TablesHome />;
  const baseId = Number(segments[0]);
  const resourceType = segments[1] === 'table' || segments[1] === 'dashboard' ? segments[1] : undefined;
  const resourceId = segments[2] ? Number(segments[2]) : undefined;
  const recordId = resourceType === 'table' ? Number(params?.get('record')) : NaN;
  if (
    !Number.isInteger(baseId) ||
    baseId <= 0 ||
    (resourceId !== undefined && (!Number.isInteger(resourceId) || resourceId <= 0))
  ) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-faint">
        {t('tables.home.invalidRoute')}
      </div>
    );
  }
  return (
    <BaseWorkspace
      baseId={baseId}
      resourceType={resourceType}
      resourceId={resourceId}
      recordId={Number.isInteger(recordId) && recordId > 0 ? recordId : undefined}
    />
  );
}
