/**
 * Pivot card: rows = the card's groups, columns = its series (a single value
 * column without one). Totals appear only where adding up is meaningful (count
 * and sum). Every cell, row header and the single-column values drill into the
 * records behind them.
 */

import type { TableCardPoint } from '@greenhouse/types/table-cards';
import type { TableAggregateRow, TableCardSpec } from '@greenhouse/types/tables';
import {
  STICKY_CELL_SURFACE,
  STICKY_HEADER_SURFACE,
  STICKY_LEFT_CELL,
  STICKY_LEFT_HEADER,
} from '../../lib/sticky-columns';
import { useT } from '../../lib/i18n';
import { Button } from '../ui';
import {
  dimensionLabel,
  dimensionSlot,
  dimensionTitle,
  formatCardNumber,
  type CardKey,
  type CardLabelContext,
} from './card-labels';
import { valueCaption } from './chart-model';

const keyOf = (key: CardKey | undefined) =>
  key === null || key === undefined ? '\u0000' : `${typeof key}:${String(key)}`;

export interface PivotModel {
  rows: Array<{ key: CardKey; label: string }>;
  /** Empty when the card has no series (one value column). */
  columns: Array<{ key: CardKey; label: string }>;
  value(row: CardKey, column?: CardKey): number | undefined;
  totals: { rows: Map<string, number>; columns: Map<string, number>; grand: number } | null;
}

export function buildPivotModel(card: TableCardSpec, rows: TableAggregateRow[], ctx: CardLabelContext): PivotModel {
  const groupDim = card.aggregate?.groupBy;
  const seriesDim = card.aggregate?.series;
  const rowKeys: CardKey[] = [];
  const seenRows = new Set<string>();
  const columnKeys: CardKey[] = [];
  const seenColumns = new Set<string>();
  const cells = new Map<string, number>();
  for (const row of rows) {
    if (!seenRows.has(keyOf(row.group))) {
      seenRows.add(keyOf(row.group));
      rowKeys.push(row.group);
    }
    if (seriesDim && !seenColumns.has(keyOf(row.series))) {
      seenColumns.add(keyOf(row.series));
      columnKeys.push(row.series ?? null);
    }
    cells.set(`${keyOf(row.group)}|${seriesDim ? keyOf(row.series) : ''}`, row.value);
  }
  columnKeys.sort(
    (left, right) => dimensionSlot(seriesDim, left, columnKeys, ctx) - dimensionSlot(seriesDim, right, columnKeys, ctx),
  );
  const additive = (card.aggregate?.operation ?? 'count') === 'count' || card.aggregate?.operation === 'sum';
  let totals: PivotModel['totals'] = null;
  if (additive && seriesDim) {
    const rowTotals = new Map<string, number>();
    const columnTotals = new Map<string, number>();
    let grand = 0;
    for (const row of rows) {
      rowTotals.set(keyOf(row.group), (rowTotals.get(keyOf(row.group)) ?? 0) + row.value);
      columnTotals.set(keyOf(row.series), (columnTotals.get(keyOf(row.series)) ?? 0) + row.value);
      grand += row.value;
    }
    totals = { rows: rowTotals, columns: columnTotals, grand };
  }
  return {
    rows: rowKeys.map((key) => ({ key, label: dimensionLabel(groupDim, key, ctx) })),
    columns: columnKeys.map((key) => ({ key, label: dimensionLabel(seriesDim, key, ctx) })),
    value: (row, column) => cells.get(`${keyOf(row)}|${seriesDim ? keyOf(column) : ''}`),
    totals,
  };
}

const CELL = 'border-b border-edge px-3 py-1.5';

export function PivotCard({
  card,
  rows,
  labels,
  onDrill,
}: {
  card: TableCardSpec;
  rows: TableAggregateRow[];
  labels: CardLabelContext;
  onDrill?: (point: TableCardPoint, label: string) => void;
}) {
  const t = useT();
  const model = buildPivotModel(card, rows, labels);
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-fg-faint">
        {t('tables.dashboard.card.noData')}
      </div>
    );
  }
  const format = (value: number | undefined) => (value === undefined ? '—' : formatCardNumber(value, labels.locale));
  const valueCell = (value: number | undefined, point: TableCardPoint, label: string) =>
    onDrill && value !== undefined ? (
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-end px-1 py-0.5 font-normal tabular-nums"
        aria-label={t('tables.dashboard.card.showRecordsFor', { label })}
        onClick={() => onDrill(point, label)}
      >
        {format(value)}
      </Button>
    ) : (
      <span className="block text-right tabular-nums">{format(value)}</span>
    );
  const hasColumns = model.columns.length > 0;

  return (
    <div className="h-full min-h-0 overflow-auto rounded-md border border-edge">
      <table className="min-w-full text-xs [&_td]:whitespace-nowrap">
        <thead className="sticky top-0 z-10 bg-surface-sunken [&_th]:whitespace-nowrap">
          <tr>
            <th
              className={`${CELL} ${STICKY_LEFT_HEADER} ${STICKY_HEADER_SURFACE} text-left font-medium text-fg-muted`}
            >
              {dimensionTitle(card.aggregate?.groupBy, labels)}
            </th>
            {hasColumns ? (
              model.columns.map((column) => (
                <th key={keyOf(column.key)} className={`${CELL} text-right font-medium text-fg-muted`}>
                  <span className="block max-w-40 truncate" title={column.label}>
                    {column.label}
                  </span>
                </th>
              ))
            ) : (
              <th className={`${CELL} text-right font-medium text-fg-muted`}>{valueCaption(card, labels)}</th>
            )}
            {model.totals && (
              <th className={`${CELL} text-right font-semibold text-fg-secondary`}>
                {t('tables.dashboard.card.total')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row) => (
            <tr key={keyOf(row.key)} className="group">
              <th
                scope="row"
                className={`${CELL} ${STICKY_LEFT_CELL} ${STICKY_CELL_SURFACE} text-left font-medium text-fg-secondary`}
              >
                <span className="block max-w-48 truncate" title={row.label}>
                  {row.label}
                </span>
              </th>
              {hasColumns ? (
                model.columns.map((column) => (
                  <td key={keyOf(column.key)} className={`${CELL} text-fg-secondary`}>
                    {valueCell(
                      model.value(row.key, column.key),
                      { group: row.key, series: column.key },
                      `${row.label} · ${column.label}`,
                    )}
                  </td>
                ))
              ) : (
                <td className={`${CELL} text-fg-secondary`}>
                  {valueCell(model.value(row.key), { group: row.key }, row.label)}
                </td>
              )}
              {model.totals && (
                <td className={`${CELL} font-semibold text-fg`}>
                  {valueCell(model.totals.rows.get(keyOf(row.key)), { group: row.key }, row.label)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {model.totals && (
          <tfoot>
            <tr>
              <th scope="row" className={`${CELL} text-left font-semibold text-fg`}>
                {t('tables.dashboard.card.total')}
              </th>
              {model.columns.map((column) => (
                <td key={keyOf(column.key)} className={`${CELL} text-right font-semibold tabular-nums text-fg`}>
                  {format(model.totals!.columns.get(keyOf(column.key)))}
                </td>
              ))}
              <td className={`${CELL} text-right font-semibold tabular-nums text-fg`}>{format(model.totals.grand)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
