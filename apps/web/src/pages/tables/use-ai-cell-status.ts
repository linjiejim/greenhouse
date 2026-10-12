import { useEffect, useState } from 'react';
import type { TableAiCellState } from '@greenhouse/types/tables';
import { getAiFieldStatus, type TableField, type TableRecord } from '../../lib/api/tables';

/** One request per visible AI column, not per cell. Closed/hidden tables stop polling. */
export function useAiCellStatus(fields: TableField[], records: TableRecord[]) {
  const fieldKey = fields
    .filter((field) => field.type === 'ai')
    .map((field) => field.id)
    .join(',');
  const recordKey = records
    .map((record) => record.id)
    .slice(0, 200)
    .join(',');
  const [states, setStates] = useState<Record<string, TableAiCellState>>({});
  useEffect(() => {
    let canceled = false;
    const load = async () => {
      const next: Record<string, TableAiCellState> = {};
      if (fieldKey && recordKey)
        await Promise.all(
          fieldKey.split(',').map(async (id) => {
            try {
              const result = await getAiFieldStatus(Number(id), recordKey.split(',').map(Number));
              for (const [recordId, cell] of Object.entries(result.records)) next[`${id}:${recordId}`] = cell.state;
            } catch {
              /* Scoped readers do not receive a whole-field job summary. */
            }
          }),
        );
      if (!canceled) setStates(next);
    };
    void load();
    const timer =
      fieldKey && recordKey
        ? setInterval(() => {
            void load();
          }, 3000)
        : undefined;
    return () => {
      canceled = true;
      if (timer) clearInterval(timer);
    };
  }, [fieldKey, recordKey]);
  return states;
}
