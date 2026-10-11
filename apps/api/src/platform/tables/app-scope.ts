/**
 * Pure pieces of app card evaluation (docs/specs/20261011-tables-apps.md §3):
 * which fields a card shows, reads and writes, and how its builder-written
 * query becomes part of a reader's scope.
 *
 * A card's scope is `role rule ∩ card fields ∩ card query`:
 * - the role rule is compiled by THE access compiler (`compileTableAccessScope`);
 * - the card query's predicates join the scope's read rows as `where` row
 *   scopes (`queryRowScopes`) — builder-written, so they may name any field
 *   and compile fail-closed exactly like a role's row predicate; the gateway
 *   additionally withholds a card whose query needs a field the role cannot
 *   read (a predicate's constants would disclose hidden values — the Phase 0
 *   `trimCardForReader` rule);
 * - `$page.<filterId>` clause values are the viewer's: they are resolved
 *   through the Phase 0 filter-control helpers (`resolvePageRefs`) and dropped
 *   when the page filter is not visible to the role, has no value, or names a
 *   field the role cannot read.
 * Everything here is data in, data out — the gateway modules do the I/O.
 */

import type { AppCard, AppDataSource, AppPage, AppRecordAction } from '@greenhouse/types/apps';
import type { TableRowScope } from '@greenhouse/types/table-access';
import type { TableFilterClause, TableFilterControl, TableFilterGroup, TableQuery } from '@greenhouse/types/tables';
import { PAGE_REF } from './app-spec.js';

export type RecordsLikeCard = Extract<AppCard, { kind: 'records' | 'kanban' | 'calendar' | 'gallery' }>;
export type AggregateCard = Extract<AppCard, { kind: 'kpi' | 'chart' | 'pivot' }>;
export type CardQuery = NonNullable<AppDataSource['query']>;

export function isRecordsCard(card: AppCard): card is RecordsLikeCard {
  return card.kind === 'records' || card.kind === 'kanban' || card.kind === 'calendar' || card.kind === 'gallery';
}

export function isAggregateCard(card: AppCard): card is AggregateCard {
  return card.kind === 'kpi' || card.kind === 'chart' || card.kind === 'pivot';
}

/** The fields a records-like card shows on its face (its columns plus the lane / date / cover fields). */
export function cardDisplayFieldIds(card: RecordsLikeCard): number[] {
  const ids = new Set(card.fieldIds);
  if (card.kind === 'kanban') ids.add(card.groupFieldId);
  if (card.kind === 'calendar') {
    ids.add(card.startFieldId);
    if (card.endFieldId !== undefined) ids.add(card.endFieldId);
  }
  if ((card.kind === 'kanban' || card.kind === 'gallery') && card.coverFieldId !== undefined)
    ids.add(card.coverFieldId);
  return [...ids];
}

/** The fields a card's record drawer shows: its detail, else its face. */
export function cardDetailFieldIds(card: RecordsLikeCard): number[] {
  return card.detail ? [...new Set(card.detail.fieldIds)] : cardDisplayFieldIds(card);
}

/** Every field a records-like card may show anywhere (face ∪ drawer) — attachments are served only from these. */
export function cardShownFieldIds(card: RecordsLikeCard): number[] {
  return [...new Set([...cardDisplayFieldIds(card), ...cardDetailFieldIds(card)])];
}

/** Row / card-face actions and the drawer's actions, in that order (ids are unique per card). */
export function cardActions(card: AppCard): AppRecordAction[] {
  if (!isRecordsCard(card)) return [];
  return [...(card.actions ?? []), ...(card.detail?.actions ?? [])];
}

/** The table and query a card reads, if it reads one. */
export function cardSource(card: AppCard): { tableId: number; query?: CardQuery } | undefined {
  if (isRecordsCard(card)) return card.source;
  if (isAggregateCard(card) && card.card.source) return card.card.source;
  return undefined;
}

// ─── $page references ─────────────────────────────────────

export function pageRefOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return PAGE_REF.exec(value)?.[1];
}

function groupsOf(query: CardQuery | undefined): TableFilterGroup[] {
  if (!query) return [];
  return [query.where, ...(query.filters ?? [])].filter((group): group is TableFilterGroup => Boolean(group));
}

/** Field ids the query's predicates, sort and grouping name — `$page` clauses excluded (they are the viewer's). */
export function queryFieldIds(query: CardQuery | undefined): number[] {
  const ids = new Set<number>();
  for (const group of groupsOf(query)) {
    for (const clause of group.clauses ?? []) {
      if (clause.fieldId !== undefined && pageRefOf(clause.value) === undefined) ids.add(clause.fieldId);
    }
  }
  for (const sort of query?.sort ?? []) if (sort.fieldId !== undefined) ids.add(sort.fieldId);
  if (query?.groupBy?.fieldId !== undefined) ids.add(query.groupBy.fieldId);
  return [...ids];
}

/**
 * A group with its `$page` clauses taken as "no constraint": removed from an
 * AND group, and an OR group holding one becomes no constraint at all.
 * Undefined when nothing is left.
 */
function withoutPageClauses(group: TableFilterGroup | undefined): TableFilterGroup | undefined {
  if (!group || !Array.isArray(group.clauses)) return undefined;
  const clauses = group.clauses.filter((clause) => pageRefOf(clause.value) === undefined);
  if (group.combinator === 'or' && group.clauses.length > 1 && clauses.length < group.clauses.length) return undefined;
  return clauses.length > 0 ? { ...group, clauses } : undefined;
}

/**
 * The query's predicates as read-row scopes (`where` rows), `$page` clauses
 * dropped — what "inside this card" means when no viewer filter is in play
 * (record detail, actions, notification recipients). Empty groups are no
 * constraint (an empty `where` row scope would be FALSE).
 */
export function queryRowScopes(query: CardQuery | undefined): TableRowScope[] {
  return groupsOf(query).flatMap((group) => {
    const kept = withoutPageClauses(group);
    return kept ? [{ type: 'where' as const, where: kept }] : [];
  });
}

/** One `$page` clause and what it binds: the clause's field (or system field) on the card's table. */
export interface PageClause {
  filterId: string;
  clause: TableFilterClause;
}

/**
 * Split a query into its own predicates and its `$page` clauses, resolving
 * each clause through `resolve` (→ the groups the page filter's value adds on
 * that field, or [] when it adds nothing — no value, a filter the role cannot
 * see, a field it cannot read). A clause that adds nothing is no constraint:
 * in an AND group (or a one-clause group) it is removed and its groups are
 * AND-ed on separately; in an OR group with other clauses the whole group
 * becomes no constraint — as it does when the value needs an AND pair there
 * (a two-sided date range), which one flat group cannot hold; single-clause
 * and OR results are inlined.
 */
export function resolvePageRefs(
  query: CardQuery | undefined,
  resolve: (ref: PageClause) => TableFilterGroup[],
): Omit<TableQuery, 'cursor' | 'limit'> {
  if (!query) return {};
  const extra: TableFilterGroup[] = [];
  const rewrite = (group: TableFilterGroup | undefined): TableFilterGroup | undefined => {
    if (!group || !Array.isArray(group.clauses)) return group;
    const own: TableFilterClause[] = [];
    const isOr = group.combinator === 'or' && group.clauses.length > 1;
    for (const clause of group.clauses) {
      const filterId = pageRefOf(clause.value);
      if (filterId === undefined) {
        own.push(clause);
        continue;
      }
      const groups = resolve({ filterId, clause }).filter((entry) => entry.clauses.length > 0);
      if (!isOr) {
        extra.push(...groups);
        continue;
      }
      const inlined = groups.every((entry) => entry.clauses.length === 1 || entry.combinator === 'or');
      if (groups.length === 0 || !inlined) return undefined;
      for (const resolved of groups) own.push(...resolved.clauses);
    }
    return own.length > 0 ? { ...group, clauses: own } : undefined;
  };
  const { where, filters, ...rest } = query;
  const out: Omit<TableQuery, 'cursor' | 'limit'> = { ...rest };
  const ownWhere = rewrite(where);
  if (ownWhere) out.where = ownWhere;
  const ownFilters = (filters ?? []).map(rewrite).filter((group): group is TableFilterGroup => Boolean(group));
  const allFilters = [...ownFilters, ...extra];
  if (allFilters.length > 0) out.filters = allFilters;
  return out;
}

/** The `$page` clauses a query uses (their fields must be readable for the value to apply). */
export function pageClauses(query: CardQuery | undefined): PageClause[] {
  return groupsOf(query).flatMap((group) =>
    (group.clauses ?? []).flatMap((clause) => {
      const filterId = pageRefOf(clause.value);
      return filterId === undefined ? [] : [{ filterId, clause }];
    }),
  );
}

/** A page's filter controls as the role sees them (`visible` = the Phase 0 reader trim, done by the caller). */
export function controlById(controls: readonly TableFilterControl[], id: string): TableFilterControl | undefined {
  return controls.find((control) => control.id === id);
}

/** The page a card sits on and the card, when the page is one of `pages`. */
export function locateCard(
  pages: readonly AppPage[],
  pageId: string,
  cardId: string,
): { page: AppPage; card: AppCard } | undefined {
  const page = pages.find((entry) => entry.id === pageId);
  const card = page?.cards.find((entry) => entry.id === cardId);
  return page && card ? { page, card } : undefined;
}
