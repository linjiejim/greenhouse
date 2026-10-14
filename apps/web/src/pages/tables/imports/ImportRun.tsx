/** A started import: its progress while it writes, then what it created and the rows it skipped. */

import { useId, useState } from 'react';
import { Button, OverlayActions, StatusBadge } from '@greenhouse/ui/kit';
import type { BaseImport } from '@greenhouse/contract';
import { cancelImport } from '../../../data/tables-imports';
import { useI18n } from '../../../lib/i18n';
import { shownColumns } from './model';
import { count, importError, rowReason, statusOf } from './words';

export function ImportProgress({ item, onClose }: { item: BaseImport; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const status = statusOf(item);
  const total = item.total_rows;
  const done = Math.min(item.committed_rows, total);
  const words = t('tables.import.progress', { done: count(done, locale), total: count(total, locale) });
  const stop = async () => {
    setStopping(true);
    setError('');
    try {
      await cancelImport(item.id);
    } catch (failure) {
      setError(importError(failure, t, locale));
      setStopping(false);
    }
  };
  return (
    <>
      <div className="app-tb-import-status">
        <StatusBadge status={t(status.key)} tone={status.tone} />
        <span className="app-tb-import-file-name">{item.file_name}</span>
      </div>
      <div className="app-tb-import-progress">
        <span className="app-tb-import-count">{words}</span>
        <div
          className="app-tb-import-bar"
          role="progressbar"
          aria-label={t('tables.import.progressLabel')}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-valuetext={words}
        >
          <span className="app-tb-import-fill" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
        <p className="app-muted">{t('tables.import.background')}</p>
      </div>
      {error && (
        <p className="app-form-error" role="alert">
          {error}
        </p>
      )}
      <OverlayActions>
        <Button loading={stopping} onClick={() => void stop()}>
          {t('tables.import.stop')}
        </Button>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </OverlayActions>
    </>
  );
}

export function ImportResult({
  item,
  onAnother,
  onClose,
}: {
  item: BaseImport;
  onAnother: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const heading = useId();
  const status = statusOf(item);
  const columns = shownColumns(item, item.header);
  const columnName = (index: number | null) =>
    index === null ? '' : (columns[index]?.name ?? t('tables.import.column', { n: index + 1 }));
  const { created, skipped, errors, more_errors: more } = item.result;
  return (
    <>
      <div className="app-tb-import-status">
        <StatusBadge status={t(status.key)} tone={status.tone} />
        <span className="app-tb-import-file-name">{item.file_name}</span>
      </div>
      {item.failure && (
        <p className="app-form-error" role="alert">
          {t(`tables.import.failure.${item.failure}`)}
        </p>
      )}
      <p className="app-tb-import-counts">
        <span>{t('tables.import.created', { count: count(created, locale) })}</span>
        <span>{t('tables.import.skipped', { count: count(skipped, locale) })}</span>
      </p>
      {item.status !== 'done' && created > 0 && <p className="app-muted">{t('tables.import.kept')}</p>}
      {errors.length > 0 && (
        <section className="app-tb-import-section">
          <h3 id={heading} className="app-tb-import-heading">
            {t('tables.import.notImported')}
          </h3>
          <ul className="app-tb-import-errors" aria-labelledby={heading}>
            {errors.map((error, index) => (
              <li key={`${error.row}:${index}`} className="app-tb-import-error">
                <span className="app-tb-import-row">{t('tables.import.row', { row: error.row })}</span>
                <span className="app-tb-import-col">{columnName(error.column)}</span>
                <span className="app-tb-import-reason">{rowReason(error, t)}</span>
              </li>
            ))}
          </ul>
          {more > 0 && <p className="app-muted">{t('tables.import.moreErrors', { count: count(more, locale) })}</p>}
        </section>
      )}
      <OverlayActions>
        <Button onClick={onAnother}>{t('tables.import.another')}</Button>
        <Button kind="primary" onClick={onClose}>
          {t('common.done')}
        </Button>
      </OverlayActions>
    </>
  );
}
