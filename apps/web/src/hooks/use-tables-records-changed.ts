/**
 * Re-read Tables data when records change elsewhere.
 *
 * The API publishes `tables:records_changed {baseId, tableId, recordIds}` after
 * every committed record write — people, forms, imports and the asynchronous
 * automation worker alike — to the online users who can open that Base. Views,
 * dashboards and the record drawer subscribe here and refetch. Events arrive
 * in bursts (an import commits a chunk at a time, a batch, an automation
 * chain), so they are coalesced (`createRefetchCoalescer`): one refetch once
 * the burst goes quiet or at most every `maxWaitMs`, never two at once.
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

export interface RefetchCoalescer<T> {
  push(event: T): void;
  dispose(): void;
}

/**
 * Debounce with a ceiling, single-flight with one trailing run. A run starts
 * `delayMs` after the last event, or `maxWaitMs` after the first one still
 * waiting, whichever is sooner. While a run is in flight (`run` returned a
 * promise) nothing else starts; events that arrive meanwhile are kept and run
 * once more as soon as it settles. So a burst of any length costs one refetch
 * per `maxWaitMs` at most, and refetches never overlap.
 */
export function createRefetchCoalescer<T>(
  run: (events: T[]) => void | Promise<unknown>,
  { delayMs, maxWaitMs }: { delayMs: number; maxWaitMs: number },
): RefetchCoalescer<T> {
  let pending: T[] = [];
  let firstPendingAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let disposed = false;

  const fire = () => {
    timer = null;
    if (inFlight || disposed || pending.length === 0) return;
    const batch = pending;
    pending = [];
    inFlight = true;
    let result: void | Promise<unknown>;
    try {
      result = run(batch);
    } catch {
      result = undefined;
    }
    void Promise.resolve(result)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        // The trailing run: whatever arrived while this one was in flight.
        if (!disposed && pending.length > 0 && !timer) fire();
      });
  };

  return {
    push(event) {
      if (disposed) return;
      if (pending.length === 0) firstPendingAt = Date.now();
      pending.push(event);
      if (timer) clearTimeout(timer);
      const ceiling = firstPendingAt + maxWaitMs - Date.now();
      timer = setTimeout(fire, Math.max(0, Math.min(delayMs, ceiling)));
    },
    dispose() {
      disposed = true;
      pending = [];
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Calls `onChange` with the coalesced events (see `createRefetchCoalescer`;
 * return the refetch's promise so a burst never runs two at once).
 * Pass `enabled: false` to pause, e.g. while a drag is in progress.
 */
export function useTablesRecordsChanged(
  filter: TablesRecordsChangedFilter,
  onChange: (events: TablesRecordsChangedEvent[]) => void | Promise<unknown>,
  options: { enabled?: boolean; delayMs?: number; maxWaitMs?: number } = {},
): void {
  const { enabled = true, delayMs = 1000, maxWaitMs = 3000 } = options;
  const callback = useRef(onChange);
  callback.current = onChange;
  const { baseId, tableId } = filter;
  const recordKey = filter.recordIds ? filter.recordIds.join(',') : '';

  useEffect(() => {
    if (!enabled) return;
    const recordIds = recordKey ? recordKey.split(',').map(Number) : undefined;
    const coalescer = createRefetchCoalescer<TablesRecordsChangedEvent>((batch) => callback.current(batch), {
      delayMs,
      maxWaitMs,
    });
    const unsubscribe = wsClient.onEvent((event) => {
      if (event.type !== 'tables:records_changed') return;
      if (!matchesRecordsChanged(event, { baseId, tableId, recordIds })) return;
      coalescer.push(event);
    });
    return () => {
      unsubscribe();
      coalescer.dispose();
    };
  }, [enabled, delayMs, maxWaitMs, baseId, tableId, recordKey]);
}
