import { useCallback } from 'react';
import { get, seg } from '../api/client';
import { memberDirectory } from '../api/me';
import { useResource } from '../data/use-resource';
import type { EditableField } from './model';
export function useFieldChoices(field: EditableField) {
  const target = field.config.table_id ?? field.table_id;
  const load = useCallback(async () => {
    if (field.type === 'member') {
      const result = await memberDirectory();
      return result.ok
        ? { ok: true as const, data: result.data.items.map((p) => ({ id: p.id, label: p.name })) }
        : result;
    }
    if (['relation', 'parent', 'dependency'].includes(field.type)) {
      const result = await get<{ items: { id: string; title: string }[] }>(`/api/tables/tables/${seg(target)}/titles`, {
        limit: 1000,
      });
      return result.ok
        ? { ok: true as const, data: result.data.items.map((p) => ({ id: p.id, label: p.title })) }
        : result;
    }
    return { ok: true as const, data: [] as { id: string; label: string }[] };
  }, [field.type, target]);
  return useResource(load, ['base.updated', 'records.changed']);
}
