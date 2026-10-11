/**
 * Re-read Tables data when records change elsewhere.
 *
 * The API publishes `tables:records_changed {baseId, tableId, recordIds}` after
 * every committed record write — people, forms, imports and the asynchronous
 * automation worker alike — to the online users who can open that Base. Views,
 * dashboards and the record drawer subscribe here and refetch; events arrive
 * in bursts (a batch, an automation chain), so they are coalesced.
 */

import { useEffect, useRef } from 'react';
import type { ServerWsEvent } from '@greenhouse/types/ws';
import { wsClient } from '../lib/ws';

export type TablesRecordsChangedEvent = Extract<ServerWsEvent, { type: 'tables:records_changed' }>;

export interface TablesRecordsChangedFilter {
  baseId?: number;
  tableId?: number;
  /** Only fire when one of these records changed. */
  recordIds?: readonly number[];
}

export function matchesRecordsChanged(event: TablesRecordsChangedEvent, filter: TablesRecordsChangedFilter): boolean {
  if (filter.baseId !== undefined && event.baseId !== filter.baseId) return false;
  if (filter.tableId !== undefined && event.tableId !== filter.tableId) return false;
  if (filter.recordIds && !filter.recordIds.some((id) => event.recordIds.includes(id))) return false;
  return true;
}

/**
 * Calls `onChange` (at most once per `delayMs`) after matching events.
 * Pass `enabled: false` to pause, e.g. while a drag is in progress.
 */
export function useTablesRecordsChanged(
  filter: TablesRecordsChangedFilter,
  onChange: (events: TablesRecordsChangedEvent[]) => void,
  options: { enabled?: boolean; delayMs?: number } = {},
): void {
  const { enabled = true, delayMs = 400 } = options;
  const callback = useRef(onChange);
  callback.current = onChange;
  const { baseId, tableId } = filter;
  const recordKey = filter.recordIds ? filter.recordIds.join(',') : '';

  useEffect(() => {
    if (!enabled) return;
    const recordIds = recordKey ? recordKey.split(',').map(Number) : undefined;
    let pending: TablesRecordsChangedEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = wsClient.onEvent((event) => {
      if (event.type !== 'tables:records_changed') return;
      if (!matchesRecordsChanged(event, { baseId, tableId, recordIds })) return;
      pending.push(event);
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const batch = pending;
        pending = [];
        callback.current(batch);
      }, delayMs);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, delayMs, baseId, tableId, recordKey]);
}
