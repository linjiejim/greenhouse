/**
 * Aggregate rows → what `<ChartBlock>` draws, plus the card point behind every
 * mark (so a click drills into exactly that group / series).
 *
 * - No series: one dataset over the groups (one colour; a pie colours slices).
 * - Series: one dataset per series key over the groups (missing cells are 0).
 * - At most eight coloured entities: beyond that the smallest fold into
 *   "Other", which has no drill-down (it is not one predicate).
 */

import type { ChartData } from '@greenhouse/types/rich-output';
import type { TableCardPoint } from '@greenhouse/types/table-cards';
import type { TableAggregateRow, TableCardSpec } from '@greenhouse/types/tables';
import type { ChartDisplayOptions } from '../blocks/chart-config';
import { CHART_SLOT_COUNT } from '../blocks/chart-config';
import { dimensionLabel, dimensionSlot, type CardKey, type CardLabelContext } from './card-labels';

export interface ChartModel {
  data: ChartData;
  display: ChartDisplayOptions;
  /** `points[datasetIndex][labelIndex]` — null where a mark has no single predicate ("Other"). */
  points: Array<Array<TableCardPoint | null>>;
  /** Human label of each point, same shape as `points`. */
  pointLabels: string[][];
}

const keyOf = (key: CardKey) => (key === null ? '\u0000null' : `${typeof key}:${String(key)}`);

function unique(keys: CardKey[]): CardKey[] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    const id = keyOf(key);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Distinct slots for the entities shown, or positions when the stable slots would collide. */
function slotsFor(slots: number[]): number[] {
  const distinct = new Set(slots).size === slots.length && slots.every((slot) => slot < CHART_SLOT_COUNT);
  return distinct ? slots : slots.map((_, index) => index);
}

/** The caption of the measured value ("Records", "Sum of Amount"). */
export function valueCaption(card: TableCardSpec, ctx: CardLabelContext): string {
  const operation = card.aggregate?.operation ?? 'count';
  if (operation === 'count') return ctx.t('tables.dashboard.card.kpi.count');
  const field = card.aggregate?.valueFieldId ? ctx.fieldsById.get(card.aggregate.valueFieldId) : undefined;
  return ctx.t(`tables.dashboard.card.kpi.${operation}`, { field: field?.name ?? '—' });
}

export function buildChartModel(card: TableCardSpec, rows: TableAggregateRow[], ctx: CardLabelContext): ChartModel {
  const chartType = card.chart?.type ?? 'bar';
  const groupDim = card.aggregate?.groupBy;
  const seriesDim = card.aggregate?.series;
  const isPie = chartType === 'pie';
  const type: ChartData['type'] = isPie
    ? card.chart?.donut
      ? 'doughnut'
      : 'pie'
    : chartType === 'area'
      ? 'line'
      : chartType;
  const display: ChartDisplayOptions = {
    stacked: card.chart?.stacked,
    horizontal: card.chart?.horizontal,
    area: chartType === 'area',
    showValues: card.chart?.showValues,
  };
  const other = ctx.t('tables.dashboard.card.other');

  if (!seriesDim) {
    let groups: Array<{ key: CardKey; value: number; other?: true }> = rows.map((row) => ({
      key: row.group,
      value: row.value,
    }));
    if (isPie && groups.length > CHART_SLOT_COUNT) {
      const ranked = [...groups].sort((left, right) => right.value - left.value);
      const kept = new Set(ranked.slice(0, CHART_SLOT_COUNT - 1).map((group) => keyOf(group.key)));
      const rest = groups.filter((group) => !kept.has(keyOf(group.key)));
      groups = [
        ...groups.filter((group) => kept.has(keyOf(group.key))),
        { key: null, value: rest.reduce((sum, group) => sum + group.value, 0), other: true },
      ];
    }
    const labels = groups.map((group) => (group.other ? other : dimensionLabel(groupDim, group.key, ctx)));
    const keys = groups.filter((group) => !group.other).map((group) => group.key);
    const pieSlots = groups.map((group) =>
      group.other ? CHART_SLOT_COUNT - 1 : dimensionSlot(groupDim, group.key, keys, ctx),
    );
    return {
      data: { type, labels, datasets: [{ label: valueCaption(card, ctx), data: groups.map((group) => group.value) }] },
      display: { ...display, ...(isPie ? { colorSlots: slotsFor(pieSlots) } : {}) },
      points: [groups.map((group) => (group.other ? null : { group: group.key }))],
      pointLabels: [labels],
    };
  }

  const groupKeys = unique(rows.map((row) => row.group));
  const totals = new Map<string, { key: CardKey; total: number }>();
  for (const row of rows) {
    const key = row.series ?? null;
    const entry = totals.get(keyOf(key)) ?? { key, total: 0 };
    entry.total += row.value;
    totals.set(keyOf(key), entry);
  }
  const allSeries = [...totals.values()].map((entry) => entry.key);
  let shown = allSeries;
  let folded: Set<string> | null = null;
  if (allSeries.length > CHART_SLOT_COUNT) {
    const ranked = [...totals.values()].sort((left, right) => right.total - left.total);
    shown = ranked.slice(0, CHART_SLOT_COUNT - 1).map((entry) => entry.key);
    folded = new Set(ranked.slice(CHART_SLOT_COUNT - 1).map((entry) => keyOf(entry.key)));
  }
  // Series in a stable order (by slot), so the legend reads the same every time.
  shown = [...shown].sort(
    (left, right) => dimensionSlot(seriesDim, left, allSeries, ctx) - dimensionSlot(seriesDim, right, allSeries, ctx),
  );
  const cell = new Map(rows.map((row) => [`${keyOf(row.group)}|${keyOf(row.series ?? null)}`, row.value]));
  const groupLabels = groupKeys.map((key) => dimensionLabel(groupDim, key, ctx));
  const datasets = shown.map((series) => ({
    label: dimensionLabel(seriesDim, series, ctx),
    data: groupKeys.map((group) => cell.get(`${keyOf(group)}|${keyOf(series)}`) ?? 0),
  }));
  const points: Array<Array<TableCardPoint | null>> = shown.map((series) =>
    groupKeys.map((group) => ({ group, series })),
  );
  const pointLabels = shown.map((series) =>
    groupKeys.map((_, index) => `${groupLabels[index]} · ${dimensionLabel(seriesDim, series, ctx)}`),
  );
  const slots = shown.map((series) => dimensionSlot(seriesDim, series, allSeries, ctx));
  if (folded) {
    datasets.push({
      label: other,
      data: groupKeys.map((group) =>
        rows
          .filter((row) => keyOf(row.group) === keyOf(group) && folded!.has(keyOf(row.series ?? null)))
          .reduce((sum, row) => sum + row.value, 0),
      ),
    });
    points.push(groupKeys.map(() => null));
    pointLabels.push(groupKeys.map((_, index) => `${groupLabels[index]} · ${other}`));
    slots.push(CHART_SLOT_COUNT - 1);
  }
  return {
    data: { type, labels: groupLabels, datasets },
    display: { ...display, colorSlots: slotsFor(slots) },
    points,
    pointLabels,
  };
}
