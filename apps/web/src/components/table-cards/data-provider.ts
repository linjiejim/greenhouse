/**
 * Where a card's result comes from — the seam between the one card renderer
 * set and its hosts (program P1). The renderers never fetch; a host hands them
 * results it got from its own gateway:
 *
 *   Tables dashboard  → `POST /api/tables/dashboard-widgets/:id/query`, keyed by widget id
 *   app page (slice R) → `POST /api/apps/:id/cards/query`, keyed by card id
 *
 * Both evaluate the same `TableCardSpec` with the same server evaluator for the
 * viewer (scope, filters, time zone), so a provider only adapts the address.
 * `useTableCardResults` is the per-card state both hosts share: every card
 * loads and fails on its own, a refresh keeps the previous result on screen,
 * and only a card's latest request lands (a slow answer for an earlier filter
 * value never replaces the one for the current value).
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { TableCardPoint, TableCardResult } from '@greenhouse/types/table-cards';
import type { TableCardSpec, TableFilterValue } from '@greenhouse/types/tables';
import type { TableField, TableRecordPage } from '../../lib/api/tables';

/** Filter values by control id; `null` clears a control's default. */
export type TableCardFilterValues = Record<string, TableFilterValue | null>;

/** What one evaluation carries besides the card: the viewer's filter values, zone, a drill point, a page. */
export interface TableCardQuery {
  filterValues: TableCardFilterValues;
  /** IANA zone for date buckets and presets — the viewer's. */
  timezone: string;
  drilldown?: TableCardPoint;
  cursor?: string;
}

/** One evaluated card: the card as this viewer may see it (null = withheld) and its result. */
export interface TableCardEvaluation {
  card: TableCardSpec | null;
  result: TableCardResult<TableRecordPage>;
}

/**
 * A host's way to evaluate its cards and describe their tables. Keys are the
 * host's own (a widget id, an app card id).
 */
export interface TableCardDataProvider<Key extends string | number = string | number> {
  /** Evaluate one card for the viewer. */
  query(key: Key, input: TableCardQuery): Promise<TableCardEvaluation>;
  /** A table's fields as the viewer may read them — labels, records columns, filter targets. */
  loadFields(tableId: number): Promise<TableField[]>;
}

/** A card's state on the client. */
export interface TableCardState {
  /** The card as this viewer may see it (null = withheld). */
  card: TableCardSpec | null;
  /** Undefined until the first answer. */
  result?: TableCardResult<TableRecordPage>;
  error?: string | null;
}

/** The viewer's IANA zone: date buckets and date presets are calendar days here. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Per-card results for one host. `query(key)` evaluates one card with the
 * current filter values; `queryMany(keys)` several at once.
 */
export function useTableCardResults<Key extends string | number>(
  provider: TableCardDataProvider<Key>,
  filterValues: TableCardFilterValues,
) {
  const [states, setStates] = useState<Partial<Record<Key, TableCardState>>>({});
  const timezone = useMemo(viewerTimeZone, []);
  const filtersRef = useRef(filterValues);
  filtersRef.current = filterValues;
  /** Per card, the latest request: an older one (an earlier filter value) must not land over it. */
  const latestRequest = useRef(new Map<Key, number>());

  const query = useCallback(
    async (key: Key) => {
      const requestId = (latestRequest.current.get(key) ?? 0) + 1;
      latestRequest.current.set(key, requestId);
      const isLatest = () => latestRequest.current.get(key) === requestId;
      try {
        const response = await provider.query(key, { filterValues: filtersRef.current, timezone });
        if (!isLatest()) return;
        setStates((previous) => ({
          ...previous,
          [key]: { card: response.card, result: response.result, error: null },
        }));
      } catch (queryError) {
        if (!isLatest()) return;
        setStates((previous) => ({
          ...previous,
          [key]: {
            card: previous[key]?.card ?? null,
            result: previous[key]?.result,
            error: queryError instanceof Error ? queryError.message : String(queryError),
          },
        }));
      }
    },
    [provider, timezone],
  );

  const queryMany = useCallback(
    async (keys: readonly Key[]) => {
      await Promise.all(keys.map((key) => query(key)));
    },
    [query],
  );

  return { states, timezone, query, queryMany };
}
