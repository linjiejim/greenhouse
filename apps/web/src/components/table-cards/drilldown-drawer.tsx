/**
 * The records behind a card point (a bar, a slice, a pivot cell, a KPI), in a
 * right-hand drawer. The host supplies the loader — the server evaluates the
 * same card query, filters and scope plus the drill predicate — so this panel
 * never builds predicates itself. A row opens its record.
 */

import { useEffect, useRef, useState } from 'react';
import type { TableSystemField } from '@greenhouse/types/tables';
import type { TableField, TableRecord, TableRecordPage } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { X } from '../../lib/icons';
import { Button, Drawer, IconButton, Spinner } from '../ui';
import type { TableUsersById } from '../tables/field-value';
import { RecordsTable } from './records-card';

export interface DrilldownRequest {
  /** Changes whenever the drawer should load a different set (widget + point + filters). */
  key: string;
  title: string;
  load: (cursor?: string) => Promise<TableRecordPage>;
}

export function DrilldownDrawer({
  request,
  fields,
  fieldIds,
  systemFields,
  usersById,
  onClose,
  onOpenRecord,
}: {
  request: DrilldownRequest | null;
  fields: readonly TableField[];
  fieldIds?: readonly number[];
  systemFields?: readonly TableSystemField[];
  usersById: TableUsersById;
  onClose: () => void;
  onOpenRecord?: (record: TableRecord) => void;
}) {
  const t = useT();
  const [records, setRecords] = useState<TableRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const loadRef = useRef(request?.load);
  loadRef.current = request?.load;
  const key = request?.key;

  useEffect(() => {
    if (!key || !loadRef.current) return;
    const current = ++generation.current;
    setRecords([]);
    setTotal(0);
    setCursor(null);
    setError('');
    setLoading(true);
    loadRef
      .current()
      .then((page) => {
        if (current !== generation.current) return;
        setRecords(page.records);
        setTotal(page.total);
        setCursor(page.nextCursor);
      })
      .catch((loadError: unknown) => {
        if (current === generation.current) {
          setError(loadError instanceof Error ? loadError.message : t('tables.dashboard.drilldown.failed'));
        }
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
  }, [key, t]);

  const loadMore = async () => {
    if (!cursor || !loadRef.current) return;
    const current = generation.current;
    setLoading(true);
    try {
      const page = await loadRef.current(cursor);
      if (current !== generation.current) return;
      setRecords((previous) => [...previous, ...page.records]);
      setCursor(page.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.dashboard.drilldown.failed'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  };

  return (
    <Drawer open={request !== null} onClose={onClose} side="right" width={640} ariaLabel={request?.title}>
      <header className="sticky top-0 z-20 flex items-start justify-between gap-3 border-b border-edge bg-surface-raised px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-fg" title={request?.title}>
            {request?.title}
          </h2>
          <p className="text-xs text-fg-faint">{t('tables.dashboard.drilldown.count', { count: total })}</p>
        </div>
        <IconButton label={t('common.close')} onClick={onClose} className="h-8 w-8 sm:h-8 sm:w-8">
          <X size={14} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="dashboard-drilldown">
        {error ? (
          <div className="px-4 py-3 text-xs text-danger">{error}</div>
        ) : records.length > 0 ? (
          <RecordsTable
            records={records}
            fields={fields}
            fieldIds={fieldIds}
            systemFields={systemFields}
            usersById={usersById}
            onOpenRecord={onOpenRecord}
          />
        ) : loading ? (
          <div className="flex justify-center py-10">
            <Spinner className="h-5 w-5 text-fg-faint" />
          </div>
        ) : (
          <div className="px-4 py-10 text-center text-xs text-fg-faint">{t('tables.dashboard.drilldown.empty')}</div>
        )}
      </div>
      {cursor && !error && (
        <footer className="border-t border-edge px-4 py-2">
          <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loading}>
            {t('tables.dashboard.drilldown.loadMore')}
          </Button>
        </footer>
      )}
    </Drawer>
  );
}
