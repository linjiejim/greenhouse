import { describe, expect, it } from 'vitest';
import type { BaseTable, Card, Field } from '@greenhouse/contract';
import { translate } from '../../../../lib/i18n';
import {
  bucketLabel,
  cardNeeds,
  cardTitle,
  dayLabel,
  defaultGroup,
  duplicateCard,
  formatFigure,
  groupFields,
  groupLabel,
  lineRuns,
  moveCard,
  newCardId,
  niceScale,
  pieSlices,
  precisionOf,
  putCard,
  restoreCard,
  sizeOf,
  slicePath,
  switchKind,
  switchTable,
  withoutCard,
} from '../model';

const zh = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('zh', key, vars);
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);

const field = (id: string, type: Field['type'], extra: Partial<Field> = {}): Field => ({
  id,
  table_id: 'tbl_1',
  name: id,
  type,
  config: {},
  required: false,
  is_primary: false,
  position: 0,
  ...extra,
});

const table = (fields: Field[]): BaseTable => ({
  id: 'tbl_1',
  base_id: 'bas_1',
  name: '任务',
  description: '',
  position: 0,
  schema_revision: 1,
  fields,
});

const card = (id: string, extra: Partial<Card> = {}): Card => ({
  id,
  kind: 'number',
  title: '',
  table_id: 'tbl_1',
  ...extra,
});

describe('card edits', () => {
  it('gives a new card an id no other card has', () => {
    const ids = ['a', 'a', 'b'];
    expect(newCardId([{ id: 'card_a' }], () => ids.shift()!)).toBe('card_b');
  });

  it('keeps what a kind uses when the kind changes', () => {
    const bar = card('c', {
      kind: 'bar',
      title: 'By status',
      filter: { mode: 'and', clauses: [{ field: 'f', op: 'is_empty' }] },
      measure: { aggregate: 'avg', field: 'n' },
      group: { field: 's' },
      size: 'large',
    });
    expect(switchKind(bar, 'list')).toEqual({
      id: 'c',
      kind: 'list',
      title: 'By status',
      table_id: 'tbl_1',
      filter: bar.filter,
      size: 'large',
      list: { fields: [] },
    });
    expect(switchKind(bar, 'number')).toEqual({ ...bar, kind: 'number', group: undefined });
    // A pie shows parts of a whole: an average becomes a count.
    expect(switchKind(bar, 'pie').measure).toEqual({ aggregate: 'count' });
    expect(switchKind(bar, 'line').group).toEqual({ field: 's' });
    expect(switchTable(bar, 'tbl_2')).toEqual({
      id: 'c',
      kind: 'bar',
      title: 'By status',
      table_id: 'tbl_2',
      size: 'large',
    });
  });

  it('says what a card still needs', () => {
    expect(cardNeeds(card('a'))).toBeNull();
    expect(cardNeeds(card('a', { measure: { aggregate: 'sum' } }))).toBe('field');
    expect(cardNeeds(card('a', { kind: 'pie' }))).toBe('group');
    expect(cardNeeds(card('a', { kind: 'list', measure: { aggregate: 'sum' } }))).toBeNull();
  });

  it('moves, copies, puts back and replaces cards', () => {
    const cards = [card('a'), card('b', { title: 'B' }), card('c')];
    expect(moveCard(cards, 'b', -1).map((entry) => entry.id)).toEqual(['b', 'a', 'c']);
    expect(moveCard(cards, 'c', 1).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    const copied = duplicateCard(cards, 'b', (name) => `${name} 副本`);
    expect(copied.map((entry) => entry.title)).toEqual(['', 'B', 'B 副本', '']);
    expect(new Set(copied.map((entry) => entry.id)).size).toBe(4);
    const without = withoutCard(cards, 'b');
    expect(restoreCard(without, cards[1]!, 1)).toEqual(cards);
    expect(restoreCard(cards, cards[1]!, 0)).toEqual(cards);
    expect(putCard(cards, { ...cards[0]!, title: 'A' })[0]!.title).toBe('A');
    expect(putCard(cards, card('d')).map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('starts a chart on a single select, else a single member, else a date by week', () => {
    const people = field('owner', 'member');
    const team = field('team', 'member', { config: { multiple: true } });
    const due = field('due', 'date');
    expect(defaultGroup([field('t', 'text'), due, people, field('s', 'single_select')])).toEqual({ field: 's' });
    expect(defaultGroup([team, due, people])).toEqual({ field: 'owner' });
    expect(defaultGroup([team, due])).toEqual({ field: 'due', bucket: 'week' });
    expect(groupFields([team, field('tags', 'multi_select'), field('notes', 'long_text')])).toEqual([]);
    expect(groupFields([field('f', 'formula', { config: { result: 'datetime' } })]).map((entry) => entry.id)).toEqual([
      'f',
    ]);
  });

  it('sizes cards by kind unless they say', () => {
    expect(sizeOf(card('a'))).toBe('small');
    expect(sizeOf(card('a', { kind: 'bar' }))).toBe('medium');
    expect(sizeOf(card('a', { kind: 'bar', size: 'large' }))).toBe('large');
  });
});

describe('words', () => {
  const fields = [
    field('n', 'number', { name: '预算', config: { precision: 2 } }),
    field('s', 'single_select', { name: '状态' }),
  ];

  it('titles a card by what it counts, and by what', () => {
    expect(cardTitle(card('a', { title: '  进度 ' }), table(fields), zh)).toBe('进度');
    expect(cardTitle(card('a'), table(fields), zh)).toBe('任务记录数');
    expect(cardTitle(card('a', { measure: { aggregate: 'sum', field: 'n' } }), table(fields), zh)).toBe('预算合计');
    expect(cardTitle(card('a', { kind: 'bar', group: { field: 's' } }), table(fields), zh)).toBe('任务记录数，按状态');
    expect(cardTitle(card('a', { kind: 'pie', group: { field: 'created_at' } }), table(fields), en)).toBe(
      '任务 records by Created',
    );
    expect(cardTitle(card('a', { kind: 'list' }), table(fields), zh)).toBe('任务');
  });

  it('writes figures with grouped digits and the field’s decimal places', () => {
    expect(formatFigure(null, 'zh')).toBe('—');
    expect(formatFigure(1234567, 'zh')).toBe('1,234,567');
    expect(formatFigure(5.4321, 'en')).toBe('5.43');
    expect(formatFigure(5, 'en', 2)).toBe('5.00');
    expect(precisionOf(card('a'), table(fields))).toBe(0);
    expect(precisionOf(card('a', { measure: { aggregate: 'sum', field: 'n' } }), table(fields))).toBe(2);
    expect(precisionOf(card('a', { measure: { aggregate: 'avg', field: 'x' } }), table(fields))).toBeUndefined();
  });

  it('words date buckets by their first day, with the year only when it is not this one', () => {
    expect(dayLabel('2026-10-13', 'zh', 2026)).toBe('10 月 13 日');
    expect(dayLabel('2025-10-13', 'en', 2026)).toBe('Oct 13, 2025');
    expect(bucketLabel('2026-10-12', 'week', 'zh', zh, 2026)).toBe('10 月 12 日起的一周');
    expect(bucketLabel('2026-10-01', 'month', 'zh', zh, 2026)).toBe('10 月');
    expect(bucketLabel('2025-10-01', 'month', 'zh', zh, 2026)).toBe('2025 年 10 月');
    expect(bucketLabel('2026-10-01', 'month', 'en', en, 2026)).toBe('Oct');
    expect(bucketLabel('2026-07-01', 'quarter', 'zh', zh, 2026)).toBe('2026 年第 3 季度');
    expect(bucketLabel('2026-01-01', 'year', 'en', en, 2026)).toBe('2026');
  });

  it('words groups by what they are keyed by', () => {
    expect(groupLabel({ key: null, label: '' }, { key_type: 'option' }, 'zh', zh)).toBe('（空）');
    expect(groupLabel({ key: 'todo', label: '待开始' }, { key_type: 'option' }, 'zh', zh)).toBe('待开始');
    expect(groupLabel({ key: 'mem_1', label: '' }, { key_type: 'member' }, 'zh', zh)).toBe('未知成员');
    expect(groupLabel({ key: 'true', label: '' }, { key_type: 'checkbox' }, 'zh', zh)).toBe('已勾选');
    expect(groupLabel({ key: '1200', label: '' }, { key_type: 'number' }, 'en', en)).toBe('1,200');
    expect(groupLabel({ key: '2026-01-01', label: '' }, { key_type: 'date', bucket: 'year' }, 'zh', zh)).toBe(
      '2026 年',
    );
  });
});

describe('geometry', () => {
  it('rounds an axis to even steps through zero', () => {
    expect(niceScale(0, 7)).toEqual({ min: 0, max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceScale(-3, 10)).toEqual({ min: -5, max: 10, ticks: [-5, 0, 5, 10] });
    expect(niceScale(0, 0)).toEqual({ min: 0, max: 1, ticks: [0, 1] });
  });

  it('breaks a line where a figure is missing', () => {
    const runs = lineRuns(
      [1, null, 2, 3],
      { width: 440, height: 120, left: 20, right: 20, top: 10, bottom: 10 },
      { min: 0, max: 4 },
    );
    expect(runs.map((run) => run.map((point) => point.index))).toEqual([[0], [2, 3]]);
    expect(runs[0]![0]).toEqual({ x: 70, y: 85, index: 0 });
  });

  it('cuts a donut into shares, counting negatives as nothing', () => {
    const slices = pieSlices([3, 1, -2, 0]);
    expect(slices.map((slice) => slice.share)).toEqual([0.75, 0.25, 0, 0]);
    expect(slices[0]!.start).toBeCloseTo(-Math.PI / 2);
    expect(slices[1]!.end).toBeCloseTo((3 * Math.PI) / 2);
    expect(pieSlices([0, 0]).map((slice) => slice.share)).toEqual([0, 0]);
    expect(slicePath(60, 60, 50, 30, 0, Math.PI / 2)).toBe(
      'M 110.00 60.00 A 50 50 0 0 1 60.00 110.00 L 60.00 90.00 A 30 30 0 0 0 90.00 60.00 Z',
    );
    // A whole ring is drawn as two halves.
    expect(slicePath(60, 60, 50, 30, 0, Math.PI * 2).match(/A /g)).toHaveLength(4);
  });
});
