/**
 * The cards of one app page on the client: every queried card (records-like
 * and aggregate kinds) evaluated by the gateway for the viewer's role, the
 * page's filter values and time zone — through the shared per-card loader
 * (`useTableCardResults`: each card loads and fails on its own, a refresh
 * keeps the previous result, only a card's latest request lands).
 *
 * - Records cards carry their own search and page (`setParams`), remembered
 *   for later refreshes; kanban and calendar cards load up to the view limit
 *   in one go (they do not page), like their Tables views.
 * - `tables:records_changed` refreshes the cards reading a changed table
 *   (coalesced and single-flight in `useTablesRecordsChanged`).
 * - `users`: the people the page's cards named — labels for aggregates and
 *   the people filter (app viewers have no directory).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AppCard, AppCardQueryResult, AppPage, AppRecordRefs, AppRuntimeView } from '@greenhouse/types/apps';
import {
  appTableFields,
  cardTableId,
  isAggregateCard,
  isQueriedCard,
  mergeRefs,
  recordsResult,
  refsUsers,
  viewTable,
  type AppCardParams,
} from '../../../components/app-cards';
import {
  useTableCardResults,
  type TableCardDataProvider,
  type TableCardFilterValues,
} from '../../../components/table-cards';
import { useTablesRecordsChanged } from '../../../hooks/use-tables-records-changed';
import { queryAppCard, type AppCardQueryRequest } from '../../../lib/api/apps';
import type { AppPreviewScope } from '../../../lib/app-routes';
import { VIEW_RECORD_LIMIT } from '../../tables/views/view-query';

/** Every page of a records card up to the view limit, as one answer (kanban and calendar do not page). */
export async function queryRecordsUpToLimit(
  appId: number,
  request: AppCardQueryRequest,
  limit = VIEW_RECORD_LIMIT,
): Promise<AppCardQueryResult> {
  let answer = await queryAppCard(appId, request);
  if (answer.kind !== 'records') return answer;
  const records = [...answer.records];
  let refs: AppRecordRefs = answer.refs;
  while (answer.kind === 'records' && answer.nextCursor && records.length < limit) {
    answer = await queryAppCard(appId, { ...request, cursor: answer.nextCursor });
    if (answer.kind !== 'records') return answer;
    records.push(...answer.records);
    refs = mergeRefs(refs, answer.refs);
  }
  const total = answer.kind === 'records' ? answer.total : records.length;
  return { kind: 'records', records: records.slice(0, limit), total, nextCursor: null, refs };
}

export function useAppPageCards({
  appId,
  view,
  page,
  preview,
  filterValues,
}: {
  appId: number;
  view: AppRuntimeView;
  page: AppPage;
  /** A manager's preview (a role, the draft): every card query carries it. */
  preview: AppPreviewScope;
  filterValues: TableCardFilterValues;
}) {
  const params = useRef(new Map<string, AppCardParams>());
  const cardsById = useMemo(() => new Map(page.cards.map((card) => [card.id, card])), [page]);
  const queried = useMemo(() => page.cards.filter(isQueriedCard), [page]);

  const provider = useMemo<TableCardDataProvider<string, AppCardQueryResult>>(
    () => ({
      query: async (cardId, input) => {
        const card = cardsById.get(cardId);
        if (!card || !isQueriedCard(card)) throw new Error(`Unknown card ${cardId}`);
        const request: AppCardQueryRequest = {
          pageId: page.id,
          cardId,
          filterValues: input.filterValues,
          timezone: input.timezone,
          ...preview,
        };
        const result =
          card.kind === 'kanban' || card.kind === 'calendar'
            ? await queryRecordsUpToLimit(appId, request)
            : await queryAppCard(appId, { ...request, ...params.current.get(cardId) });
        return { card: isAggregateCard(card) ? card.card : null, result };
      },
      loadFields: async (tableId) => appTableFields(viewTable(view, tableId)),
    }),
    [appId, cardsById, page.id, preview, view],
  );
  const { states, query, queryMany } = useTableCardResults(provider, filterValues);

  // First load, a new view (another role previewed) and new filter values re-evaluate every card.
  const queriedKey = queried.map((card) => card.id).join('\n');
  const filterKey = JSON.stringify(filterValues);
  useEffect(() => {
    if (queriedKey) void queryMany(queriedKey.split('\n'));
  }, [queryMany, queriedKey, filterKey]);

  /** Re-evaluate the cards that read `tableId` (after a write, or someone else's). */
  const refreshTable = useCallback(
    (tableId: number | undefined) =>
      queryMany(
        queried.filter((card) => tableId === undefined || cardTableId(card) === tableId).map((card) => card.id),
      ),
    [queried, queryMany],
  );

  useTablesRecordsChanged({ baseId: view.app.baseId }, (events) => {
    const tables = new Set(events.map((event) => event.tableId));
    return queryMany(queried.filter((card) => tables.has(cardTableId(card) ?? -1)).map((card) => card.id));
  });

  const setParams = useCallback(
    (card: AppCard, next: AppCardParams) => {
      params.current.set(card.id, next);
      void query(card.id);
    },
    [query],
  );
  const retry = useCallback((card: AppCard) => void query(card.id), [query]);

  const users = useMemo(
    () => refsUsers(mergeRefs(...Object.values(states).map((state) => recordsResult(state)?.refs))),
    [states],
  );

  return useMemo(
    () => ({ states, query, refreshTable, setParams, retry, users }),
    [query, refreshTable, retry, setParams, states, users],
  );
}
