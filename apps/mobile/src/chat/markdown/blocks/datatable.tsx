/**
 * ```datatable fenced block — the agent's structured table ({ title?, columns:
 * [{ key, label, type? }], rows }) on the same native grid as a markdown table
 * (./table: measured columns, horizontal scroll, the pinned expand glyph →
 * `/table`). Values are formatted by column type like the web DataTableBlock
 * (number / currency / percent / boolean / badge; numeric columns align
 * right), render as literal text, and a tap on a header sorts by that column
 * (ascending → descending → original order). Invalid JSON falls back to code.
 */
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { DataTableColumn, DataTableData } from '../../../shared/rich-output';
import { useT, useLocale, type TFunction } from '../../../lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../../../theme';
import { selectionTick } from '../../../ui/haptics';
import type { Align, TableData } from '../parse';
import { richSegment } from '../rich';
import { CodeBlock } from './code';
import { Table } from './table';

const NUMERIC = new Set(['number', 'currency', 'percent']);

function formatCell(value: unknown, type: DataTableColumn['type'], t: TFunction, locale: string): string {
  if (value == null || value === '') return '—';
  const num = typeof value === 'number' ? value : NaN;
  switch (type) {
    case 'number':
      return Number.isFinite(num) ? num.toLocaleString(locale) : String(value);
    case 'currency':
      return Number.isFinite(num)
        ? `$${num.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
        : String(value);
    case 'percent': {
      const p = typeof value === 'number' ? value : parseFloat(String(value));
      if (!Number.isFinite(p)) return String(value);
      return `${p > 0 ? '+' : ''}${(p * 100).toFixed(1)}%`;
    }
    case 'boolean':
      return value ? t('common.yes') : t('common.no');
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

function sortValue(value: unknown, type: DataTableColumn['type']): number | string {
  if (value == null) return '';
  if (type && NUMERIC.has(type)) return typeof value === 'number' ? value : parseFloat(String(value)) || 0;
  if (type === 'boolean') return value ? 1 : 0;
  return String(value).toLowerCase();
}

export function DataTableBlock({ raw }: { raw: string }) {
  const seg = useMemo(() => richSegment('datatable', raw), [raw]);
  if (seg?.type !== 'datatable') return <CodeBlock lang="datatable" code={raw} />;
  return <DataTable data={seg.data} />;
}

function DataTable({ data }: { data: DataTableData }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const locale = useLocale();
  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null);

  const table = useMemo<TableData>(() => {
    const { columns } = data;
    let rows = data.rows;
    if (sort) {
      const col = columns[sort.col];
      const sign = sort.dir === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const x = sortValue(a[col.key], col.type);
        const y = sortValue(b[col.key], col.type);
        return (x < y ? -1 : x > y ? 1 : 0) * sign;
      });
    }
    return {
      head: columns.map((col, j) => (sort?.col === j ? `${col.label} ${sort.dir === 'asc' ? '↑' : '↓'}` : col.label)),
      rows: rows.map((row) => columns.map((col) => formatCell(row[col.key], col.type, t, locale))),
      align: columns.map((col): Align => (col.type && NUMERIC.has(col.type) ? 'right' : 'left')),
      plain: true,
    };
  }, [data, sort, t, locale]);

  const onHeadPress = (col: number) => {
    selectionTick();
    setSort((s) => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null));
  };

  return (
    <View>
      {data.title ? <Text style={styles.title}>{data.title}</Text> : null}
      <Table data={table} title={data.title} onHeadPress={data.rows.length > 1 ? onHeadPress : undefined} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label, marginTop: space.sm, marginBottom: -space.xs },
}));
