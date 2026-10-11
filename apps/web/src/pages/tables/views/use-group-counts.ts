/**
 * Records per group over the whole query — the grid's group headers and the
 * kanban lane counts. The loaded records are a page (or the first 500), so a
 * header counting what is on screen would lie; the server's aggregate counts
 * every matching record with the same readable-field rules as the query.
 *
 * `version` refetches: pass the loaded records, so a reload (an edit, a
 * realtime refetch, a drag) recounts.
 */

import { useEffect, useState } from 'react';
import type { TableGroupBy } from '@greenhouse/types/tables';
import { aggregateTableRecords, type TableField } from '../../../lib/api/tables';
import type { TableViewQuery } from './types';
import { countsByGroup, groupCountInput, viewerTimeZone } from './view-query';

export function useGroupCounts(
  tableId: number,
  groupBy: TableGroupBy | undefined,
  field: TableField | undefined,
  query: TableViewQuery,
  version: unknown,
): ReadonlyMap<string, number> | null {
  const [counts, setCounts] = useState<ReadonlyMap<string, number> | null>(null);
  const inputKey = groupBy ? JSON.stringify(groupCountInput(groupBy, field, query, viewerTimeZone())) : '';

  useEffect(() => {
    if (!inputKey) {
      setCounts(null);
      return;
    }
    let alive = true;
    aggregateTableRecords(tableId, JSON.parse(inputKey))
      .then((rows) => {
        if (alive) setCounts(countsByGroup(rows));
      })
      // Counts are decoration: a failure leaves the headers without numbers.
      .catch(() => {
        if (alive) setCounts(null);
      });
    return () => {
      alive = false;
    };
  }, [tableId, inputKey, version]);

  return counts;
}
