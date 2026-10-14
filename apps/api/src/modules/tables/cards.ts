/**
 * Dashboards and their cards (TBL-13). A dashboard is a view of a base with no table; its config
 * is `{ cards }` (cardSchema, which apps reuse), kept to what the base has when it is saved. What a
 * card shows is worked out in SQL with the reader's own access (scope.ts): only the fields they
 * see, only the records they see, `$me` and the days in the filter for them. A card that cannot
 * be worked out answers why (`{ kind: 'error' }`), so the rest of the dashboard still shows.
 */

import { and, eq, inArray, isNull, max, sql, type SQL } from 'drizzle-orm';
import {
  DEFAULT_CARD_GROUPS,
  DEFAULT_CARD_LIST,
  MAX_CARD_GROUPS,
  MAX_CARD_LIST,
  OPTION_COLORS,
  canGroupBy,
  canSortBy,
  isSystemField,
  operatorsFor,
  roleAtLeast,
  valueTypeOf,
  type Card,
  type CardAggregate,
  type CardData,
  type CardError,
  type CardGroup,
  type CardGroupKey,
  type CreateDashboardInput,
  type DashboardData,
  type DateBucket,
  type FieldType,
  type OptionColor,
  type SystemField,
  type View,
  type ViewConfig,
} from '@greenhouse/contract';
import { baseRecords, baseTables, baseViews, getDb, newId, transaction, type BaseFieldRow } from '@greenhouse/db';
import { runWithConcurrency } from '@greenhouse/utils/concurrency';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { ApiError, forbidden, invalidInput, notFound } from '../../http/errors.js';
import { memberNames } from '../knowledge/views.js';
import { baseAt, loadReader, type TablesReader } from './access.js';
import type { TablesKit } from './kit.js';
import { configOf, fieldsOf, fill, tableAt, toRecord, toView, viewAt, type TableAt } from './load.js';
import {
  compileFilter,
  compileOrder,
  inIds,
  recordsWhere,
  valueKey,
  valueNumber,
  valueText,
  type QueryContext,
} from './query.js';
import { scopeOf } from './scope.js';

/** Cards of one dashboard worked out at the same time. */
const CARDS_AT_ONCE = 4;
/** A date value, and the start of a date-time value, as stored. */
const DAY_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
const INSTANT_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T';
/** Text groups are told apart by their first characters. */
const TEXT_KEY_MAX = 200;

type Kind = FieldType | SystemField;
const DATE_KINDS: readonly Kind[] = ['date', 'datetime', 'created_at', 'updated_at'];

/** The kind a field's value behaves as: a computed field as what it yields. */
const kindOf = (field: BaseFieldRow): FieldType =>
  valueTypeOf({ type: field.type, config: { result: field.config.result } });
/** A chart groups by one value per record (canGroupBy), or by a date in buckets. */
const groupable = (kind: Kind) => DATE_KINDS.includes(kind) || canGroupBy(kind);

/** Why a card shows no figures (thrown inside a card's work, answered as `{ kind: 'error' }`). */
class CardProblem extends Error {
  constructor(readonly code: CardError) {
    super(code);
  }
}
const problem = (code: CardError) => new CardProblem(code);

/** A data table as a reader sees it, for the cards on it. */
interface Source {
  at: TableAt;
  /** Every live field of the table: a field that is not here is gone, not hidden. */
  live: ReadonlyMap<string, BaseFieldRow>;
  /** The fields the reader sees. */
  visible: ReadonlyMap<string, BaseFieldRow>;
  /** Which records the reader sees (undefined: all). */
  rows: SQL | undefined;
}

/** What a group or a whole card adds up: records, and the sum, count, least and most of its numbers. */
type Tally = {
  n: number;
  s: number | null;
  c: number;
  lo: number | null;
  hi: number | null;
};
type GroupRow = Tally & { k: string | null; rest: boolean };

const figure = (aggregate: CardAggregate, tally: Tally): number | null => {
  switch (aggregate) {
    case 'count':
      return tally.n;
    case 'sum':
      return tally.s ?? 0;
    case 'avg':
      return tally.c ? (tally.s ?? 0) / tally.c : null;
    case 'min':
      return tally.lo;
    case 'max':
      return tally.hi;
  }
};

const either = (a: number | null, b: number | null, pick: (x: number, y: number) => number) =>
  a === null ? b : b === null ? a : pick(a, b);
const merge = (a: Tally, b: Tally): Tally => ({
  n: a.n + b.n,
  s: either(a.s, b.s, (x, y) => x + y),
  c: a.c + b.c,
  lo: either(a.lo, b.lo, Math.min),
  hi: either(a.hi, b.hi, Math.max),
});
const NOTHING: Tally = { n: 0, s: null, c: 0, lo: null, hi: null };

/** The first day of the bucket before or after this one (buckets start on a Monday, the 1st, Jan 1…). */
export function shiftBucket(day: string, bucket: DateBucket, by: 1 | -1): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  switch (bucket) {
    case 'day':
      date.setUTCDate(date.getUTCDate() + by);
      break;
    case 'week':
      date.setUTCDate(date.getUTCDate() + 7 * by);
      break;
    case 'month':
      date.setUTCMonth(date.getUTCMonth() + by);
      break;
    case 'quarter':
      date.setUTCMonth(date.getUTCMonth() + 3 * by);
      break;
    case 'year':
      date.setUTCFullYear(date.getUTCFullYear() + by);
      break;
  }
  return date.toISOString().slice(0, 10);
}

/** How the groups rank when only the top ones are kept: by their figure, the largest first. */
const RANK: Record<CardAggregate, SQL> = {
  count: sql.raw('n DESC'),
  sum: sql.raw('coalesce(s, 0) DESC'),
  avg: sql.raw('(s / nullif(c, 0)) DESC NULLS LAST'),
  min: sql.raw('lo DESC NULLS LAST'),
  max: sql.raw('hi DESC NULLS LAST'),
};

const colorOf = (color: string | undefined): OptionColor | undefined =>
  (OPTION_COLORS as readonly string[]).includes(color ?? '') ? (color as OptionColor) : undefined;

/**
 * A card kept to its base's live fields when a dashboard is saved: references to fields that are
 * gone are dropped, settings that do not suit a field are refused, keys its kind does not use are
 * dropped. A card that lacks something (a sum without its field) is kept and shows why.
 */
function cleanCard(card: Card, fields: readonly BaseFieldRow[]): Card {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const refuse = (message: string) => invalidInput(message, { card: card.id });
  const kindOfRef = (ref: string): Kind | undefined =>
    isSystemField(ref) ? ref : byId.has(ref) ? kindOf(byId.get(ref)!) : undefined;
  const out: Card = { id: card.id, kind: card.kind, title: card.title, table_id: card.table_id };
  if (card.filter) {
    const clauses = card.filter.clauses.filter((clause) => {
      const kind = kindOfRef(clause.field);
      if (!kind) return false;
      if (!operatorsFor(kind).includes(clause.op)) throw refuse(`A card's filter cannot use ${clause.op} there.`);
      return true;
    });
    if (clauses.length) out.filter = { mode: card.filter.mode, clauses };
  }
  if (card.kind !== 'list' && card.measure) {
    const { aggregate, field: ref } = card.measure;
    if (aggregate === 'count' || !ref) out.measure = { aggregate };
    else {
      const kind = kindOfRef(ref);
      if (kind && kind !== 'number') throw refuse('Only a number field can be added up.');
      out.measure = kind ? { aggregate, field: ref } : { aggregate };
    }
  }
  if ((card.kind === 'bar' || card.kind === 'line' || card.kind === 'pie') && card.group) {
    const { field: ref, bucket, limit } = card.group;
    const kind = kindOfRef(ref);
    if (kind) {
      if (!groupable(kind)) throw refuse('A chart cannot group records by that field.');
      const date = DATE_KINDS.includes(kind);
      if (bucket && !date) throw refuse('Only dates group into days, weeks, months, quarters or years.');
      out.group = { field: ref, ...(date ? { bucket: bucket ?? 'day' } : {}), ...(limit ? { limit } : {}) };
    }
  }
  if (card.kind === 'list' && card.list) {
    const shown = [...new Set(card.list.fields)].filter((id) => byId.has(id) && !byId.get(id)!.isPrimary);
    const sorts = (card.list.sorts ?? []).filter((sort) => {
      const kind = kindOfRef(sort.field);
      if (!kind) return false;
      if (!canSortBy(kind)) throw refuse('A list cannot be sorted by that field.');
      return true;
    });
    out.list = {
      fields: shown,
      ...(sorts.length ? { sorts } : {}),
      ...(card.list.limit ? { limit: card.list.limit } : {}),
    };
  }
  if (card.size) out.size = card.size;
  return out;
}

export function createCards(kit: TablesKit) {
  /** A card's table as the reader sees it; null when it is gone, in another base or not theirs to see. */
  async function sourceOf(reader: TablesReader, tableId: string, baseId: string | null): Promise<Source | null> {
    try {
      const at = await tableAt(reader, tableId, 'viewer');
      if (baseId && at.base.id !== baseId) return null;
      const [scope, live] = await Promise.all([scopeOf(reader, at), fieldsOf(tableId)]);
      return {
        at,
        live: new Map(live.map((field) => [field.id, field])),
        visible: new Map(scope.fields.map((field) => [field.id, field])),
        rows: scope.rows,
      };
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
  }

  function measureOf(card: Card, source: Source): { aggregate: CardAggregate; x: SQL } {
    const measure = card.measure ?? { aggregate: 'count' as const };
    if (measure.aggregate === 'count') return { aggregate: 'count', x: sql`NULL::numeric` };
    if (!measure.field || isSystemField(measure.field)) throw problem('incomplete');
    const field = source.visible.get(measure.field);
    if (!field) throw problem('field_hidden');
    if (kindOf(field) !== 'number') throw problem('incomplete');
    return { aggregate: measure.aggregate, x: valueNumber(field) };
  }

  interface Grouping {
    key: SQL;
    type: CardGroupKey;
    bucket?: DateBucket;
    options?: NonNullable<BaseFieldRow['config']['options']>;
  }

  /** What a chart's records group by: one key per record, as text. */
  function groupingOf(card: Card, source: Source, reader: TablesReader): Grouping {
    const group = card.group;
    if (!group) throw problem('incomplete');
    const bucket = group.bucket ?? 'day';
    /** The first day of the bucket an instant falls in, in the reader's zone. */
    const inBucket = (instant: SQL) =>
      sql`to_char(date_trunc(${bucket}::text, ${instant} AT TIME ZONE ${reader.timeZone}::text), 'YYYY-MM-DD')`;
    if (isSystemField(group.field)) {
      if (group.field === 'created_at') return { key: inBucket(sql`${baseRecords.createdAt}`), type: 'date', bucket };
      if (group.field === 'updated_at') return { key: inBucket(sql`${baseRecords.updatedAt}`), type: 'date', bucket };
      if (group.field === 'created_by') return { key: sql`${baseRecords.createdBy}`, type: 'member' };
      throw problem('incomplete');
    }
    const field = source.visible.get(group.field);
    if (!field) throw problem('field_hidden');
    const text = valueText(field);
    const kind = kindOf(field);
    switch (kind) {
      case 'date':
        return {
          key: sql`(CASE WHEN ${text} ~ ${DAY_PATTERN} THEN to_char(date_trunc(${bucket}::text, (${text})::date::timestamp), 'YYYY-MM-DD') END)`,
          type: 'date',
          bucket,
        };
      case 'datetime':
        return {
          key: sql`(CASE WHEN ${text} ~ ${INSTANT_PATTERN} THEN ${inBucket(sql`(${text})::timestamptz`)} END)`,
          type: 'date',
          bucket,
        };
      case 'single_select': {
        // A value that is no longer an option reads as empty, as it does in a cell.
        const options = field.config.options ?? [];
        const ids = options.map((option) => option.id);
        const key = ids.length ? sql`(CASE WHEN ${inIds(text, ids)} THEN ${text} END)` : sql`NULL::text`;
        return { key, type: 'option', options };
      }
      case 'member':
        // A member field groups by its first member (canGroupBy).
        return { key: sql`(${baseRecords.values} -> ${field.id} ->> 0)`, type: 'member' };
      case 'checkbox':
        return { key: sql`(CASE WHEN ${valueKey(field)} THEN 'true' ELSE 'false' END)`, type: 'checkbox' };
      case 'number':
        return { key: sql`((${valueNumber(field)})::float8)::text`, type: 'number' };
      default:
        if (!canGroupBy(kind)) throw problem('incomplete');
        return { key: sql`left(nullif(${text}, ''), ${TEXT_KEY_MAX})`, type: 'text' };
    }
  }

  async function numberOf(card: Card, source: Source, where: SQL): Promise<CardData> {
    const { aggregate, x } = measureOf(card, source);
    const [row] = await getDb()
      .select({
        n: sql<number>`count(*)::int`,
        s: sql<number | null>`sum(${x})::float8`,
        c: sql<number>`count(${x})::int`,
        lo: sql<number | null>`min(${x})::float8`,
        hi: sql<number | null>`max(${x})::float8`,
      })
      .from(baseRecords)
      .where(where);
    const tally = row ?? NOTHING;
    return { kind: 'number', value: figure(aggregate, tally), records: tally.n };
  }

  /**
   * One figure per group, worked out in one query: every group adds up its records, the top ones
   * are kept (for dates the latest), and what is left adds up as one more row. Dates then fill
   * the buckets in between, up to the card's limit counted back from the latest.
   */
  async function groupsOf(card: Card, source: Source, where: SQL, reader: TablesReader): Promise<CardData> {
    const grouping = groupingOf(card, source, reader);
    const { aggregate, x } = measureOf(card, source);
    const limit = Math.min(card.group?.limit ?? DEFAULT_CARD_GROUPS, MAX_CARD_GROUPS);
    const dated = grouping.type === 'date';
    const top = dated
      ? sql`(SELECT * FROM g WHERE k IS NOT NULL ORDER BY k DESC LIMIT ${limit}) UNION ALL (SELECT * FROM g WHERE k IS NULL)`
      : sql`SELECT * FROM g ORDER BY ${RANK[aggregate]}, n DESC, k ASC NULLS LAST LIMIT ${limit}`;
    const rows = [
      ...(await getDb().execute<GroupRow>(sql`
        WITH r AS (SELECT ${grouping.key} AS k, ${x} AS x FROM ${baseRecords} WHERE ${where}),
        g AS (
          SELECT k, count(*)::int AS n, sum(x)::float8 AS s, count(x)::int AS c, min(x)::float8 AS lo, max(x)::float8 AS hi
          FROM r GROUP BY k
        ),
        top AS (${top})
        SELECT k, n, s, c, lo, hi, false AS rest FROM top
        UNION ALL
        SELECT NULL, count(*)::int, sum(x)::float8, count(x)::int, min(x)::float8, max(x)::float8, true
        FROM r WHERE NOT EXISTS (SELECT 1 FROM top WHERE top.k IS NOT DISTINCT FROM r.k)
        HAVING count(*) > 0`)),
    ];
    let rest: Tally | null = rows.find((row) => row.rest) ?? null;
    const kept = rows.filter((row) => !row.rest);
    const empty = kept.find((row) => row.k === null);
    let shown = kept.filter((row) => row.k !== null);
    if (dated && shown.length) {
      const bucket = grouping.bucket!;
      shown.sort((a, b) => (a.k! < b.k! ? -1 : 1));
      const latest = shown[shown.length - 1]!.k!;
      let start = latest;
      for (let step = 1; step < limit; step++) start = shiftBucket(start, bucket, -1);
      if (shown[0]!.k! > start) start = shown[0]!.k!;
      for (const row of shown.filter((entry) => entry.k! < start)) rest = rest ? merge(rest, row) : row;
      const byKey = new Map(shown.map((row) => [row.k!, row]));
      const filled: GroupRow[] = [];
      for (let day = start; day <= latest && filled.length < limit; day = shiftBucket(day, bucket, 1)) {
        filled.push(byKey.get(day) ?? { ...NOTHING, k: day, rest: false });
      }
      shown = filled;
    } else if (grouping.type === 'option') {
      const order = new Map((grouping.options ?? []).map((option, index) => [option.id, index]));
      shown.sort((a, b) => (order.get(a.k!) ?? 0) - (order.get(b.k!) ?? 0));
    } else if (grouping.type === 'checkbox') {
      shown.sort((a, b) => Number(b.k === 'true') - Number(a.k === 'true'));
    } else {
      const value = (row: Tally) => figure(aggregate, row) ?? -Infinity;
      shown.sort((a, b) => value(b) - value(a) || b.n - a.n || (a.k! < b.k! ? -1 : 1));
    }
    const ordered = empty ? [...shown, empty] : shown;
    const names =
      grouping.type === 'member' ? await memberNames(ordered.map((row) => row.k)) : new Map<string, string>();
    const options = new Map((grouping.options ?? []).map((option) => [option.id, option]));
    const groups = ordered.map((row): CardGroup => {
      const option = row.k ? options.get(row.k) : undefined;
      const label =
        row.k === null
          ? ''
          : grouping.type === 'option'
            ? (option?.label ?? '')
            : grouping.type === 'member'
              ? (names.get(row.k) ?? '')
              : grouping.type === 'text'
                ? row.k
                : '';
      const color = colorOf(option?.color);
      return { key: row.k, label, ...(color ? { color } : {}), value: figure(aggregate, row), records: row.n };
    });
    return {
      kind: 'groups',
      key_type: grouping.type,
      ...(grouping.bucket ? { bucket: grouping.bucket } : {}),
      groups,
      other: rest ? { value: figure(aggregate, rest), records: rest.n } : null,
      records: rows.reduce((sum, row) => sum + row.n, 0),
    };
  }

  /** The first records in the card's order, with only its fields that the reader sees. */
  async function listOf(card: Card, source: Source, where: SQL, ctx: QueryContext, reader: TablesReader) {
    const limit = Math.min(card.list?.limit ?? DEFAULT_CARD_LIST, MAX_CARD_LIST);
    const primary = [...source.visible.values()].find((field) => field.isPrimary);
    const shown = [...new Set(card.list?.fields ?? [])]
      .map((id) => source.visible.get(id))
      .filter((field): field is BaseFieldRow => !!field && !field.isPrimary);
    const sorts = (card.list?.sorts ?? []).filter((sort) =>
      isSystemField(sort.field)
        ? true
        : source.visible.has(sort.field) && canSortBy(kindOf(source.visible.get(sort.field)!)),
    );
    const [rows, [total]] = await Promise.all([
      getDb()
        .select()
        .from(baseRecords)
        .where(where)
        .orderBy(...compileOrder(sorts, null, ctx))
        .limit(limit),
      getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(baseRecords)
        .where(where),
    ]);
    const fields = primary ? [primary, ...shown] : shown;
    const { at } = source;
    const filled = await fill(rows, fields, {
      files: kit.files,
      memberId: reader.memberId,
      baseId: at.base.id,
      viewer: at.access ? { reader, access: at.access } : null,
    });
    return {
      kind: 'list' as const,
      title_field: primary?.id ?? null,
      fields: shown.map((field) => field.id),
      items: rows.map((row) => toRecord(row, filled.values.get(row.id)!, fields)),
      linked: filled.linked,
      files: filled.files,
      records: total?.n ?? 0,
    };
  }

  /** What one card shows, in its own transaction (a failure stays with the card). */
  async function work(reader: TablesReader, card: Card, source: Source): Promise<CardData> {
    // A filter on a field the reader may not see is never worked out for them; one on a field that
    // is gone is left out, as in a view.
    for (const clause of card.filter?.clauses ?? []) {
      if (!isSystemField(clause.field) && !source.visible.has(clause.field) && source.live.has(clause.field)) {
        throw problem('field_hidden');
      }
    }
    const ctx: QueryContext = { fields: source.visible, memberId: reader.memberId, timeZone: reader.timeZone };
    const where = recordsWhere(source.at.table.id, source.rows, compileFilter(card.filter, ctx));
    return transaction(() => {
      switch (card.kind) {
        case 'number':
          return numberOf(card, source, where);
        case 'list':
          return listOf(card, source, where, ctx, reader);
        default:
          return groupsOf(card, source, where, reader);
      }
    });
  }

  async function answer(reader: TablesReader, card: Card, source: Source | null): Promise<CardData> {
    if (!source) return { kind: 'error', code: 'table_hidden' };
    try {
      return await work(reader, card, source);
    } catch (error) {
      if (error instanceof CardProblem) return { kind: 'error', code: error.code };
      // A setting the field no longer suits (compileFilter and compileOrder refuse those).
      if (error instanceof ApiError && error.status === 400) return { kind: 'error', code: 'incomplete' };
      logger.warn('[tables] a dashboard card could not be worked out', {
        table: card.table_id,
        kind: card.kind,
        error: toErrorMessage(error),
      });
      return { kind: 'error', code: 'failed' };
    }
  }

  /** Every card, its table read once per request; a few cards at a time, each on its own. */
  async function answerAll(reader: TablesReader, cards: readonly Card[], baseId: string | null) {
    const sources = new Map<string, Source | null>();
    for (const tableId of new Set(cards.map((card) => card.table_id))) {
      sources.set(tableId, await sourceOf(reader, tableId, baseId));
    }
    const answers: CardData[] = new Array(cards.length);
    await runWithConcurrency([...cards.keys()], CARDS_AT_ONCE, async (index) => {
      const card = cards[index]!;
      answers[index] = await answer(reader, card, sources.get(card.table_id) ?? null);
    });
    return answers;
  }

  return {
    /** A dashboard of a base, without cards: shared (builders) or only mine (anyone who sees the base). */
    async createDashboard(memberId: string, baseId: string, input: CreateDashboardInput): Promise<View> {
      const reader = await loadReader(memberId);
      const { base, role } = await baseAt(reader, baseId, 'viewer');
      const personal = input.personal ?? false;
      if (!personal && !roleAtLeast(role, 'builder')) {
        throw forbidden('Only builders add shared dashboards. Make it a personal one instead.');
      }
      const [last] = await getDb()
        .select({ top: max(baseViews.position) })
        .from(baseViews)
        .where(and(eq(baseViews.baseId, baseId), isNull(baseViews.tableId)));
      const [row] = await getDb()
        .insert(baseViews)
        .values({
          id: newId('baseView'),
          baseId,
          tableId: null,
          name: input.name,
          type: 'dashboard',
          ownerId: personal ? memberId : null,
          config: { cards: [] },
          position: (last?.top ?? -1) + 1,
          createdBy: memberId,
        })
        .returning();
      await kit.baseChanged(base, personal ? memberId : undefined);
      return toView(row!, reader, role);
    },

    /** What every card of a dashboard shows the reader now, in the dashboard's order. */
    async dashboard(memberId: string, viewId: string): Promise<DashboardData> {
      const reader = await loadReader(memberId);
      const at = await viewAt(reader, viewId);
      if (at.view.type !== 'dashboard' || at.table) throw notFound('Dashboard');
      const cards = configOf(at.view).cards ?? [];
      const answers = await answerAll(reader, cards, at.base.id);
      return {
        revision: at.view.revision,
        items: cards.map((card, index) => ({ id: card.id, data: answers[index]! })),
      };
    },

    /** What one card shows the reader, saved or not (the card editor's preview). */
    async query(memberId: string, card: Card): Promise<CardData> {
      const reader = await loadReader(memberId);
      const [data] = await answerAll(reader, [card], null);
      return data!;
    },

    /**
     * A dashboard's settings kept to what its base has: only cards, ids unique, each on a data
     * table of this base (another base's is refused). A card on a data table in the recycle bin
     * stays as it is and comes back with it; one whose table was deleted for good goes, like a
     * field that is gone; the rest are checked against their table's live fields (cleanCard).
     */
    async cleanDashboard(baseId: string, config: ViewConfig): Promise<ViewConfig> {
      const cards = config.cards ?? [];
      const ids = new Set<string>();
      for (const card of cards) {
        if (ids.has(card.id)) throw invalidInput('Two cards of a dashboard have the same id.', { card: card.id });
        ids.add(card.id);
      }
      const tableIds = [...new Set(cards.map((card) => card.table_id))];
      const tables = tableIds.length
        ? await getDb()
            .select({ id: baseTables.id, baseId: baseTables.baseId, archivedAt: baseTables.archivedAt })
            .from(baseTables)
            .where(inArray(baseTables.id, tableIds))
        : [];
      const found = new Map(tables.map((table) => [table.id, table]));
      const fields = await fieldsOf(
        tables.filter((table) => table.baseId === baseId && !table.archivedAt).map((table) => table.id),
      );
      const kept: Card[] = [];
      for (const card of cards) {
        const table = found.get(card.table_id);
        if (!table) continue;
        if (table.baseId !== baseId) {
          throw invalidInput('A card counts the records of a data table of this base.', { card: card.id });
        }
        kept.push(
          table.archivedAt
            ? card
            : cleanCard(
                card,
                fields.filter((field) => field.tableId === table.id),
              ),
        );
      }
      return { cards: kept };
    },
  };
}

export type CardsPart = ReturnType<typeof createCards>;
