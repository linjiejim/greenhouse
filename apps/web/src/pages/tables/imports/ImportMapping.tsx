/** A draft: where each column goes and whether the first row is the header, then 开始导入. */

import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button, Checkbox, OverlayActions, Select, type SelectOption } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { BaseImport, BaseTable } from '@greenhouse/contract';
import { saveImport, startImport } from '../../../data/tables-imports';
import { cx } from '../../../lib/cx';
import { useI18n } from '../../../lib/i18n';
import { FieldIcon } from '../cells';
import {
  importTargets,
  liveMapping,
  mapColumn,
  missingRequired,
  rowsWith,
  shownColumns,
  type ShownColumn,
} from './model';
import { count, importError, nameList } from './words';

export function ImportMapping({
  item,
  table,
  onBack,
  onClose,
}: {
  item: BaseImport;
  table: BaseTable;
  onBack: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const targets = importTargets(table.fields);
  const [header, setHeader] = useState(item.header);
  const [chosen, setMapping] = useState(item.mapping);
  // A field deleted while the drawer is open reads as 不导入.
  const mapping = liveMapping(chosen, targets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const columns = shownColumns(item, header);
  const nameOf = (column: ShownColumn) => column.name ?? t('tables.import.column', { n: column.index + 1 });
  const total = rowsWith(item, header);
  const missing = missingRequired(table.fields, mapping);
  const expired = !!item.expires_at && Date.parse(item.expires_at) <= Date.now();
  const blocked = expired
    ? t('tables.import.expired')
    : !mapping.some(Boolean)
      ? t('tables.import.nothingMapped')
      : !total
        ? t('tables.import.noRows')
        : missing.length
          ? t('tables.import.requiredMissing', {
              fields: nameList(
                missing.map((field) => field.name),
                locale,
              ),
            })
          : '';

  // Closing, or choosing another file, keeps the choices made here with the draft for later.
  const latest = useRef({ header, mapping, changed: false, started: false });
  latest.current = {
    ...latest.current,
    header,
    mapping,
    changed: header !== item.header || mapping.some((id, index) => id !== (item.mapping[index] ?? null)),
  };
  useEffect(
    () => () => {
      const last = latest.current;
      if (last.changed && !last.started) {
        void saveImport(item.id, { header: last.header, mapping: last.mapping }).catch(() => undefined);
      }
    },
    [item.id],
  );

  const start = async () => {
    setBusy(true);
    setError('');
    latest.current.started = true;
    try {
      // The dialog moves on to the progress once the queued import is in the cache.
      await startImport(item.id, { header, mapping });
    } catch (failure) {
      latest.current.started = false;
      setError(importError(failure, t, locale));
      setBusy(false);
    }
  };

  const usedBy = new Map<string, number>();
  mapping.forEach((id, index) => {
    if (id) usedBy.set(id, index);
  });
  const options = (index: number): SelectOption[] => [
    { value: '', label: t('tables.import.skip') },
    ...targets.map((field) => {
      const other = usedBy.get(field.id);
      return {
        value: field.id,
        label: field.name,
        icon: <FieldIcon type={field.type} />,
        description:
          other !== undefined && other !== index && columns[other]
            ? t('tables.import.usedBy', { column: nameOf(columns[other]) })
            : t(`tables.type.${field.type}`),
      };
    }),
  ];

  return (
    <>
      <div className="app-tb-import-file">
        <span className="app-tb-import-file-name">{item.file_name}</span>
        <span className="app-muted">{t('tables.import.rows', { count: count(total, locale) })}</span>
        <span className="app-tb-import-spacer" />
        <Button size="sm" kind="ghost" onClick={onBack}>
          {t('tables.import.otherFile')}
        </Button>
      </div>
      <Checkbox checked={header} onChange={setHeader} label={t('tables.import.header')} />
      <ul className="app-tb-import-map" aria-label={t('tables.import.columns')}>
        {columns.map((column) => {
          const name = nameOf(column);
          return (
            <li key={column.index} className="app-tb-import-column">
              <span className="app-tb-import-source">
                <span className={cx('app-tb-import-name', !column.name && 'is-unnamed')}>{name}</span>
                <span className="app-tb-import-samples">
                  {column.samples.length ? column.samples.join(' · ') : t('tables.import.empty')}
                </span>
              </span>
              <ArrowRight size={icon.sm} strokeWidth={icon.stroke} className="app-tb-import-arrow" aria-hidden />
              <Select
                className="app-tb-import-target"
                label={t('tables.import.fieldFor', { column: name })}
                value={mapping[column.index] ?? ''}
                options={options(column.index)}
                onChange={(value) => setMapping(mapColumn(mapping, column.index, value || null))}
              />
            </li>
          );
        })}
      </ul>
      {blocked && <p className={cx('app-tb-import-note', (expired || missing.length > 0) && 'is-danger')}>{blocked}</p>}
      {error && (
        <p className="app-form-error" role="alert">
          {error}
        </p>
      )}
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          kind="primary"
          loading={busy}
          disabled={!!blocked}
          disabledReason={blocked || undefined}
          onClick={() => void start()}
        >
          {t('tables.import.start')}
        </Button>
      </OverlayActions>
    </>
  );
}
