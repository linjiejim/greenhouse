/**
 * CSV import into a table (TBL-10): choose a file, map its columns to fields, follow the import
 * and read what it skipped. A drawer on wide screens, a bottom sheet on narrow ones. Closing it
 * leaves an import running; its recent imports bring it back.
 */

import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { FileUp } from 'lucide-react';
import { Button, ErrorBox, Overlay, OverlayActions, Skeleton, StatusBadge } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { MAX_IMPORT_BYTES, isImportActive, type Base, type BaseImport, type BaseTable } from '@greenhouse/contract';
import { useSession } from '../../../app/session';
import { uploadImport, useImport, useImports } from '../../../data/tables-imports';
import { cx } from '../../../lib/cx';
import { useI18n } from '../../../lib/i18n';
import { relativeTime } from '../../../lib/time';
import { ImportMapping } from './ImportMapping';
import { ImportProgress, ImportResult } from './ImportRun';
import { count, importError, statusOf } from './words';
import '../../../styles/tables-import.css';

export function ImportDialog({ table, onClose }: { base: Base; table: BaseTable; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [id, setId] = useState<string | null>(null);
  const current = useImport(id);
  const item = current.data;
  const back = () => setId(null);
  let body: ReactNode;
  if (!id) body = <ChooseFile table={table} onOpen={setId} onClose={onClose} />;
  else if (current.isError) {
    body = (
      <>
        <ErrorBox onRetry={() => void current.refetch()}>{importError(current.error, t, locale)}</ErrorBox>
        <OverlayActions>
          <Button onClick={back}>{t('tables.import.another')}</Button>
        </OverlayActions>
      </>
    );
  } else if (!item) body = <Skeleton lines={4} />;
  else if (item.status === 'draft') {
    body = <ImportMapping key={item.id} item={item} table={table} onBack={back} onClose={onClose} />;
  } else if (isImportActive(item.status)) body = <ImportProgress item={item} onClose={onClose} />;
  else body = <ImportResult item={item} onAnother={back} onClose={onClose} />;
  return (
    <Overlay title={t('tables.import.title', { table: table.name })} help={t('tables.import.help')} onClose={onClose}>
      <div className="app-tb-import">{body}</div>
    </Overlay>
  );
}

/** A file dropped or picked, read by the server into a draft; below, the member's recent imports. */
function ChooseFile({
  table,
  onOpen,
  onClose,
}: {
  table: BaseTable;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const recent = useImports(table.id);
  const heading = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const send = async (file: File | undefined) => {
    if (!file || busy) return;
    setError('');
    if (file.size > MAX_IMPORT_BYTES) {
      setError(t('tables.import.error.too_large'));
      return;
    }
    setBusy(true);
    try {
      onOpen((await uploadImport(table.id, file)).id);
    } catch (failure) {
      setError(importError(failure, t, locale));
      setBusy(false);
    }
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    void send(event.dataTransfer.files[0]);
  };
  const timeZone = me?.timezone ?? 'Asia/Shanghai';
  const meta = (entry: BaseImport) => {
    const summary = isImportActive(entry.status)
      ? t('tables.import.progress', {
          done: count(entry.committed_rows, locale),
          total: count(entry.total_rows, locale),
        })
      : entry.status === 'draft'
        ? t('tables.import.rows', { count: count(entry.total_rows, locale) })
        : `${t('tables.import.created', { count: count(entry.result.created, locale) })} · ${t('tables.import.skipped', { count: count(entry.result.skipped, locale) })}`;
    return t('tables.import.recentMeta', { summary, time: relativeTime(entry.created_at, { locale, timeZone }) });
  };
  const items = recent.data?.items ?? [];
  return (
    <>
      <div
        className={cx('app-tb-import-drop', over && 'is-over')}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={(event) => {
          // Moving over the words and the button inside is still over the area.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={drop}
      >
        <FileUp size={icon.lg} strokeWidth={icon.stroke} aria-hidden />
        <p className="app-tb-import-drop-title">{t('tables.import.drop')}</p>
        <p className="app-muted">{t('tables.import.limits')}</p>
        <Button kind="primary" loading={busy} onClick={() => picker.current?.click()}>
          {t('tables.import.choose')}
        </Button>
        <input
          ref={picker}
          type="file"
          accept=".csv,text/csv"
          hidden
          aria-label={t('tables.import.choose')}
          onChange={(event) => {
            void send(event.target.files?.[0]);
            // The same file can be picked again after an error.
            event.target.value = '';
          }}
        />
      </div>
      {error && (
        <p className="app-form-error" role="alert">
          {error}
        </p>
      )}
      {items.length > 0 && (
        <section className="app-tb-import-section" aria-labelledby={heading}>
          <h3 id={heading} className="app-tb-import-heading">
            {t('tables.import.recent')}
          </h3>
          <ul className="app-list">
            {items.map((entry) => {
              const status = statusOf(entry);
              return (
                <li key={entry.id}>
                  <button type="button" className="app-list-row" onClick={() => onOpen(entry.id)}>
                    <span className="app-list-main">
                      <span className="app-list-title">{entry.file_name}</span>
                      <span className="app-list-meta">{meta(entry)}</span>
                    </span>
                    <StatusBadge status={t(status.key)} tone={status.tone} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
      </OverlayActions>
    </>
  );
}
