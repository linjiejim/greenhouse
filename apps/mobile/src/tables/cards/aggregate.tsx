/**
 * The bodies of aggregate cards — KPI, chart, pivot, text — shared by Tables
 * dashboards and app pages (one renderer per kind, spec P1). The numbers come
 * evaluated from the server (`evaluateTableCard`, the same for both); the
 * phone only labels and draws them:
 *
 *  - KPI: the chat `stats` view with one tile (value + "Records" / "Sum of X");
 *  - chart: the chat chart view (Swift Charts where the binary has them, else
 *    SVG) fed by `buildChartModel`; an area chart draws as a line and stacked /
 *    horizontal bars as grouped bars (the native chart module has no such marks
 *    yet — a later native batch);
 *  - pivot: rows × columns with totals where adding up means something;
 *  - text: Markdown.
 */

import React, { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { TableCardSpec } from '../../shared/tables';
import { Markdown } from '../../chat/markdown';
import { ChartView } from '../../chat/markdown/blocks/chart';
import { StatsView } from '../../chat/markdown/blocks/stats';
import { useLocale } from '../../lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../../theme';
import { useCardCopy } from '../labels';
import {
  buildChartModel,
  buildPivotModel,
  formatCardNumber,
  valueCaption,
  type AggregateRow,
  type CardLabelContext,
} from '../model/cards';
import type { FieldLike } from '../model/fields';

export function useCardLabelContext(
  fields: readonly FieldLike[],
  userLabel: (id: string) => string | undefined,
): CardLabelContext {
  const copy = useCardCopy();
  const locale = useLocale();
  return useMemo(
    () => ({ fieldsById: new Map(fields.map((field) => [field.id, field])), userLabel, copy, locale }),
    [fields, userLabel, copy, locale],
  );
}

export function KpiBody({ spec, value, ctx }: { spec: TableCardSpec; value: number; ctx: CardLabelContext }) {
  return (
    <StatsView
      bare
      data={{ items: [{ label: valueCaption(spec, ctx), value: formatCardNumber(value, ctx.locale) }] }}
    />
  );
}

export function ChartBody({
  spec,
  rows,
  ctx,
}: {
  spec: TableCardSpec;
  rows: readonly AggregateRow[];
  ctx: CardLabelContext;
}) {
  const model = useMemo(() => buildChartModel(spec, rows, ctx), [spec, rows, ctx]);
  return <ChartView data={model.data} />;
}

export function PivotBody({
  spec,
  rows,
  ctx,
}: {
  spec: TableCardSpec;
  rows: readonly AggregateRow[];
  ctx: CardLabelContext;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const model = useMemo(() => buildPivotModel(spec, rows, ctx), [spec, rows, ctx]);
  const fmt = (value: number | undefined) => (value === undefined ? '—' : formatCardNumber(value, ctx.locale));
  const columns = model.columns.length ? model.columns : [{ key: null, label: valueCaption(spec, ctx) }];
  const total = ctx.copy.total;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        <View style={[styles.row, styles.headRow]}>
          <Text style={[styles.cell, styles.first, styles.headText]} numberOfLines={1} />
          {columns.map((column, index) => (
            <Text key={index} style={[styles.cell, styles.headText]} numberOfLines={2}>
              {column.label}
            </Text>
          ))}
          {model.totals ? <Text style={[styles.cell, styles.headText]}>{total}</Text> : null}
        </View>
        {model.rows.map((row, index) => (
          <View key={index} style={styles.row}>
            <Text style={[styles.cell, styles.first]} numberOfLines={2}>
              {row.label}
            </Text>
            {columns.map((column, columnIndex) => (
              <Text key={columnIndex} style={[styles.cell, styles.num]}>
                {fmt(model.columns.length ? model.value(row.key, column.key) : model.value(row.key))}
              </Text>
            ))}
            {model.totals ? (
              <Text style={[styles.cell, styles.num, styles.total]}>
                {fmt(model.totals.rows.get(model.rowKey(row.key)))}
              </Text>
            ) : null}
          </View>
        ))}
        {model.totals ? (
          <View style={styles.row}>
            <Text style={[styles.cell, styles.first, styles.total]}>{total}</Text>
            {model.columns.map((column, index) => (
              <Text key={index} style={[styles.cell, styles.num, styles.total]}>
                {fmt(model.totals!.columns.get(model.rowKey(column.key)))}
              </Text>
            ))}
            <Text style={[styles.cell, styles.num, styles.total]}>{fmt(model.totals.grand)}</Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

export function TextBody({ markdown }: { markdown: string }) {
  return <Markdown source={markdown} />;
}

const useStyles = makeStyles((c) => ({
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: c.separator },
  headRow: { borderBottomColor: c.opaqueSeparator },
  cell: { ...typo.footnote, color: c.label, width: 96, paddingVertical: space.sm, paddingHorizontal: space.xs },
  first: { width: 132 },
  headText: { color: c.secondaryLabel, fontWeight: weight.semibold },
  num: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  total: { fontWeight: weight.semibold },
}));
