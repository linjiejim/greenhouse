/**
 * What a dashboard works out without drawing anything: card edits (new ids, moves, copies,
 * switching kind), which fields a card can use, default titles, the words for groups and date
 * buckets, figures as text, and the geometry of line and pie charts. No React here.
 */

import {
  DEFAULT_CARD_GROUPS,
  DEFAULT_CARD_LIST,
  canGroupBy,
  canSortBy,
  isSystemField,
  valueTypeOf,
  type BaseTable,
  type Card,
  type CardData,
  type CardGroup,
  type CardKind,
  type DateBucket,
  type Field,
  type FieldType,
  type SystemField,
} from '@greenhouse/contract';
import type { Translate } from '../../../lib/i18n';

type Kind = FieldType | SystemField;
type Locale = 'zh' | 'en';
type Size = NonNullable<Card['size']>;

export const CARD_SIZES_BY_KIND: Record<CardKind, Size> = {
  number: 'small',
  bar: 'medium',
  line: 'medium',
  pie: 'medium',
  list: 'medium',
};
export const sizeOf = (card: Card): Size => card.size ?? CARD_SIZES_BY_KIND[card.kind];

/** What the server answers for a card of this kind. */
export const dataKindOf = (kind: CardKind): CardData['kind'] =>
  kind === 'number' ? 'number' : kind === 'list' ? 'list' : 'groups';

export const isChart = (kind: CardKind) => kind === 'bar' || kind === 'line' || kind === 'pie';

const DATE_KINDS: readonly Kind[] = ['date', 'datetime', 'created_at', 'updated_at'];
export const isDateKind = (kind: Kind | undefined) => !!kind && DATE_KINDS.includes(kind);

/** The kind a field's value behaves as (a formula as what it yields). */
export const kindOf = (field: Field): FieldType => valueTypeOf(field);
/** A field id or a system field, as a card names it, to its kind. */
export function kindOfRef(fields: readonly Field[], ref: string | undefined): Kind | undefined {
  if (!ref) return undefined;
  if (isSystemField(ref)) return ref;
  const field = fields.find((entry) => entry.id === ref);
  return field ? kindOf(field) : undefined;
}

/** Fields a sum, an average, the least or the most can read. */
export const numberFields = (fields: readonly Field[]) => fields.filter((field) => kindOf(field) === 'number');

/** What a chart can group by: one value per record (not several members), or a date in buckets. */
export const groupFields = (fields: readonly Field[]) =>
  fields.filter((field) => {
    const kind = kindOf(field);
    if (kind === 'member' && field.config.multiple) return false;
    return isDateKind(kind) || canGroupBy(kind);
  });
export const GROUP_SYSTEM_FIELDS = ['created_by', 'created_at', 'updated_at'] as const satisfies readonly SystemField[];

/** Fields a list can show after the title, and sort by. */
export const listFields = (fields: readonly Field[]) => fields.filter((field) => !field.is_primary);
export const sortFields = (fields: readonly Field[]) => fields.filter((field) => canSortBy(kindOf(field)));

/** A card id no other card of the dashboard has. */
export function newCardId(cards: readonly Pick<Card, 'id'>[], random: () => string = randomId): string {
  const taken = new Set(cards.map((card) => card.id));
  for (;;) {
    const id = `card_${random()}`;
    if (!taken.has(id)) return id;
  }
}
const randomId = () => Math.random().toString(36).slice(2, 10);

/** A new card on a table: a count of its records. */
export function blankCard(cards: readonly Card[], tableId: string, kind: CardKind = 'number'): Card {
  return switchKind({ id: newCardId(cards), kind: 'number', title: '', table_id: tableId }, kind);
}

/**
 * The card as another kind: its table, filter, title and size stay; what the new kind does not
 * use goes; a chart keeps its group, a list starts with no extra fields.
 */
export function switchKind(card: Card, kind: CardKind): Card {
  const { measure, group, list, ...rest } = card;
  const next: Card = { ...rest, kind };
  if (kind !== 'list' && measure) next.measure = measure;
  if (isChart(kind) && group) next.group = group;
  if (kind === 'list') next.list = list ?? { fields: [] };
  // A pie shows parts of a whole: a count or a sum.
  if (kind === 'pie' && next.measure && next.measure.aggregate !== 'count' && next.measure.aggregate !== 'sum') {
    next.measure = { aggregate: 'count' };
  }
  return next;
}

/** The same card on another table: only the kind, title and size carry over. */
export const switchTable = (card: Card, tableId: string): Card =>
  switchKind(
    { id: card.id, kind: card.kind, title: card.title, table_id: tableId, ...(card.size ? { size: card.size } : {}) },
    card.kind,
  );

/** What a new chart groups by first: a single select, else a single member, else a date. */
export function defaultGroup(fields: readonly Field[]): Card['group'] {
  const choices = groupFields(fields);
  const field =
    choices.find((entry) => kindOf(entry) === 'single_select') ??
    choices.find((entry) => kindOf(entry) === 'member') ??
    choices.find((entry) => isDateKind(kindOf(entry)));
  if (!field) return undefined;
  return isDateKind(kindOf(field)) ? { field: field.id, bucket: 'week' } : { field: field.id };
}

/** Why a card cannot be saved yet (null: it can). */
export function cardNeeds(card: Card): 'field' | 'group' | null {
  if (card.kind !== 'list' && card.measure && card.measure.aggregate !== 'count' && !card.measure.field) return 'field';
  if (isChart(card.kind) && !card.group) return 'group';
  return null;
}

/** Decimal places of a card's figures: none for counts, the field's own for the rest (else up to two). */
export function precisionOf(card: Card, table: BaseTable | undefined): number | undefined {
  const aggregate = card.measure?.aggregate ?? 'count';
  if (aggregate === 'count') return 0;
  const field = table?.fields.find((entry) => entry.id === card.measure?.field);
  const precision = field?.config.precision;
  // An average of whole numbers is rarely whole.
  return aggregate === 'avg' && precision === 0 ? undefined : precision;
}

export const putCard = (cards: readonly Card[], card: Card): Card[] =>
  cards.some((entry) => entry.id === card.id)
    ? cards.map((entry) => (entry.id === card.id ? card : entry))
    : [...cards, card];

export const withoutCard = (cards: readonly Card[], id: string): Card[] => cards.filter((card) => card.id !== id);

/** One place earlier (-1) or later (1); the same list when it cannot move. */
export function moveCard(cards: readonly Card[], id: string, by: -1 | 1): Card[] {
  const at = cards.findIndex((card) => card.id === id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= cards.length) return [...cards];
  const next = [...cards];
  [next[at], next[to]] = [next[to]!, next[at]!];
  return next;
}

/** A copy right after the card, with a new id and the title the caller words (「… 副本」). */
export function duplicateCard(cards: readonly Card[], id: string, title: (name: string) => string): Card[] {
  const at = cards.findIndex((card) => card.id === id);
  if (at < 0) return [...cards];
  const source = cards[at]!;
  const copy: Card = {
    ...structuredClone(source),
    id: newCardId(cards),
    title: source.title ? title(source.title) : '',
  };
  return [...cards.slice(0, at + 1), copy, ...cards.slice(at + 1)];
}

/** Puts a card back where it was (an undone delete). */
export function restoreCard(cards: readonly Card[], card: Card, index: number): Card[] {
  if (cards.some((entry) => entry.id === card.id)) return [...cards];
  const at = Math.max(0, Math.min(index, cards.length));
  return [...cards.slice(0, at), card, ...cards.slice(at)];
}

/** A field's or a system field's name. */
export function refName(fields: readonly Field[], ref: string | undefined, t: Translate): string {
  if (!ref) return '';
  if (isSystemField(ref)) return t(`tables.system.${ref}`);
  return fields.find((field) => field.id === ref)?.name ?? '';
}

/** The title a card shows when it has none of its own: what it counts, and by what. */
export function cardTitle(card: Card, table: BaseTable | undefined, t: Translate): string {
  if (card.title.trim()) return card.title.trim();
  const fields = table?.fields ?? [];
  const tableName = table?.name ?? '';
  if (card.kind === 'list') return tableName || t('tables.dashboards.untitled');
  const aggregate = card.measure?.aggregate ?? 'count';
  const field = refName(fields, card.measure?.field, t);
  const measure =
    aggregate === 'count' || !field
      ? t('tables.dashboards.title.count', { table: tableName })
      : t(`tables.dashboards.title.${aggregate}`, { field });
  const group = refName(fields, card.group?.field, t);
  return isChart(card.kind) && group ? t('tables.dashboards.title.by', { measure, group }) : measure;
}

// ── Words for figures, groups and dates ──────────────────

/** A figure as text: grouped digits, the field's decimal places (else up to two); — for none. */
export function formatFigure(value: number | null | undefined, locale: Locale, precision?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    minimumFractionDigits: precision ?? 0,
    maximumFractionDigits: precision ?? (Number.isInteger(value) ? 0 : 2),
  });
}

const partsOf = (day: string) => day.split('-').map(Number) as [number, number, number];

/** A day as 「10 月 16 日」 or "Oct 16", with the year when it is not this one. */
export function dayLabel(day: string, locale: Locale, thisYear = new Date().getFullYear()): string {
  const [year, month, date] = partsOf(day);
  if (locale === 'zh') return `${year === thisYear ? '' : `${year} 年 `}${month} 月 ${date} 日`;
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
    ...(year === thisYear ? {} : { year: 'numeric' }),
  });
}

/** The words for a date bucket by its first day. */
export function bucketLabel(
  day: string,
  bucket: DateBucket,
  locale: Locale,
  t: Translate,
  thisYear = new Date().getFullYear(),
): string {
  const [year, month] = partsOf(day);
  switch (bucket) {
    case 'day':
      return dayLabel(day, locale, thisYear);
    case 'week':
      return t('tables.dashboards.weekOf', { date: dayLabel(day, locale, thisYear) });
    case 'month':
      if (locale === 'zh') return year === thisYear ? `${month} 月` : `${year} 年 ${month} 月`;
      return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
        month: 'short',
        timeZone: 'UTC',
        ...(year === thisYear ? {} : { year: 'numeric' }),
      });
    case 'quarter':
      return t('tables.dashboards.quarterOf', { year, q: Math.floor((month - 1) / 3) + 1 });
    case 'year':
      return t('tables.dashboards.yearOf', { year });
  }
}

type GroupsData = Extract<CardData, { kind: 'groups' }>;

/** The words for one group of a chart. */
export function groupLabel(
  group: Pick<CardGroup, 'key' | 'label'>,
  data: Pick<GroupsData, 'key_type' | 'bucket'>,
  locale: Locale,
  t: Translate,
): string {
  if (group.key === null) return t('tables.grid.groupEmpty');
  switch (data.key_type) {
    case 'option':
    case 'text':
      return group.label || group.key;
    case 'member':
      return group.label || t('tables.dashboards.unknownMember');
    case 'checkbox':
      return group.key === 'true' ? t('tables.checked') : t('tables.unchecked');
    case 'date':
      return bucketLabel(group.key, data.bucket ?? 'day', locale, t);
    case 'number':
      return formatFigure(Number(group.key), locale);
  }
}

/** The rest past a chart's limit: 「其他」, or 「更早」 for dates. */
export const otherLabel = (data: Pick<GroupsData, 'key_type'>, t: Translate) =>
  data.key_type === 'date' ? t('tables.dashboards.earlier') : t('tables.dashboards.other');

/** How many groups a chart shows when its card does not say. */
export const groupLimit = (card: Card) => card.group?.limit ?? DEFAULT_CARD_GROUPS;
export const listLimit = (card: Card) => card.list?.limit ?? DEFAULT_CARD_LIST;

/** The chart colours, in order (`--gh-chart-1` is the brand colour). */
export const SERIES = 8;
export const seriesOf = (index: number) => (index % SERIES) + 1;

// ── Geometry ────────────────────────────────────────────

/** Round steps for an axis from min to max (0 always in it): about `count` steps. */
export function niceScale(low: number, high: number, count = 4): { min: number; max: number; ticks: number[] } {
  const min = Math.min(0, low);
  const max = Math.max(0, high);
  if (min === max) return { min: 0, max: 1, ticks: [0, 1] };
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= raw) ?? 10) * power;
  const from = Math.floor(min / step) * step;
  const to = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let tick = from; tick <= to + step / 2; tick += step) ticks.push(Number(tick.toPrecision(12)));
  return { min: from, max: to, ticks };
}

/**
 * Points of a line across `width` × `height` (inside the padding), one per value; null values
 * break the line, so it comes as runs of points.
 */
export function lineRuns(
  values: ReadonlyArray<number | null>,
  box: { width: number; height: number; left: number; right: number; top: number; bottom: number },
  scale: { min: number; max: number },
): Array<Array<{ x: number; y: number; index: number }>> {
  const inner = { width: box.width - box.left - box.right, height: box.height - box.top - box.bottom };
  const band = inner.width / Math.max(1, values.length);
  const span = scale.max - scale.min || 1;
  const runs: Array<Array<{ x: number; y: number; index: number }>> = [];
  let run: Array<{ x: number; y: number; index: number }> = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push({
      x: box.left + band * (index + 0.5),
      y: box.top + inner.height - ((value - scale.min) / span) * inner.height,
      index,
    });
  });
  if (run.length) runs.push(run);
  return runs;
}

/** A donut's slices: each value's share of the total (negative values count as nothing). */
export function pieSlices(values: readonly number[]): Array<{ start: number; end: number; share: number }> {
  const clean = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = clean.reduce((sum, value) => sum + value, 0);
  let angle = -Math.PI / 2;
  return clean.map((value) => {
    const share = total ? value / total : 0;
    const start = angle;
    angle += share * Math.PI * 2;
    return { start, end: angle, share };
  });
}

/** The SVG path of a donut slice from `start` to `end` (radians, clockwise from three o'clock). */
export function slicePath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const at = (radius: number, angle: number) =>
    `${(cx + radius * Math.cos(angle)).toFixed(2)} ${(cy + radius * Math.sin(angle)).toFixed(2)}`;
  if (end - start >= Math.PI * 2 - 1e-9) {
    // A whole ring: two halves, since one arc cannot end where it starts.
    return [
      `M ${at(outer, start)} A ${outer} ${outer} 0 1 1 ${at(outer, start + Math.PI)} A ${outer} ${outer} 0 1 1 ${at(outer, start)}`,
      `M ${at(inner, start)} A ${inner} ${inner} 0 1 0 ${at(inner, start + Math.PI)} A ${inner} ${inner} 0 1 0 ${at(inner, start)} Z`,
    ].join(' ');
  }
  const large = end - start > Math.PI ? 1 : 0;
  return [
    `M ${at(outer, start)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${at(outer, end)}`,
    `L ${at(inner, end)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${at(inner, start)}`,
    'Z',
  ].join(' ');
}
