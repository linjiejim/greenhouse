/**
 * The recycle bin for a table's deleted records.
 *
 * Records are soft-deleted, and this is the self-service half of that promise:
 * an editor can undo their own mistake without finding an administrator.
 * Deleted Bases and tables deliberately do NOT appear here — those are archived
 * too, but restoring one is a `pnpm cli tables restore-*` conversation with an
 * admin (spec D2).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { listDeletedTableRecords, restoreTableRecord, type TableField, type TableRecord } from '../../lib/api/tables';
import { Button, Drawer, EmptyState, Spinner } from '../../components/ui';
import { Trash2, X } from '../../lib/icons';
import { formatDate } from '../../lib/utils';
import { renderTableFieldValue } from './field-value';
import { useT } from '../../lib/i18n';

interface RecycleBinDrawerProps {
  open: boolean;
  tableId: number;
  /** Used to label each row the way the grid does, rather than by id. */
  primaryField?: TableField;
  usersById: ReadonlyMap<string, { nickname: string }>;
  onClose: () => void;
  onRestored: () => void;
}

export function RecycleBinDrawer({
  open,
  tableId,
  primaryField,
  usersById,
  onClose,
  onRestored,
}: RecycleBinDrawerProps) {
  const t = useT();
  const [records, setRecords] = useState<TableRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRecords(await listDeletedTableRecords(tableId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.loadDeletedRecordsFailed'));
    } finally {
      setLoading(false);
    }
  }, [tableId, t]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const restore = async (record: TableRecord) => {
    setRestoring(record.id);
    setError('');
    try {
      await restoreTableRecord(tableId, record.id);
      setRecords((current) => current.filter((entry) => entry.id !== record.id));
      onRestored();
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : t('tables.restoreRecordFailed'));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} side="right" width={420} ariaLabel={t('tables.recycleBin')}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex flex-shrink-0 items-center gap-2 border-b border-edge px-4 py-3">
          <Trash2 size={16} className="text-fg-muted" />
          <h2 className="flex-1 text-sm font-semibold text-fg">{t('tables.recycleBin')}</h2>
          <button
            type="button"
            aria-label={t('common.close')}
            className="rounded p-1.5 text-fg-faint hover:bg-surface-muted hover:text-fg"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </header>
        {error && <p className="flex-shrink-0 bg-danger-subtle px-4 py-2 text-xs text-danger">{error}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && records.length === 0 ? (
            <div className="flex justify-center py-10">
              <Spinner className="h-5 w-5 text-fg-faint" />
            </div>
          ) : records.length === 0 ? (
            <EmptyState
              icon={Trash2}
              variant="compact"
              tone="neutral"
              title={t('tables.nothingDeleted')}
              description={t('tables.deletedRecordsHint')}
            />
          ) : (
            <ul className="divide-y divide-edge">
              {records.map((record) => (
                <li key={record.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-fg">
                      {primaryField ? (
                        renderTableFieldValue(primaryField, record.values[String(primaryField.id)], usersById)
                      ) : (
                        <span className="text-fg-faint">{t('tables.recordNumber', { id: record.id })}</span>
                      )}
                    </p>
                    <p className="mt-0.5 text-[11px] text-fg-faint">
                      {t('tables.deletedAt', { date: formatDate(record.updated_at) })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={restoring === record.id}
                    onClick={() => void restore(record)}
                  >
                    {restoring === record.id ? t('tables.restoring') : t('common.restore')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Drawer>
  );
}
