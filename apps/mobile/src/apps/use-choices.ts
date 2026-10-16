import { useCallback } from 'react';
import { appCard } from '../api/apps';
import { memberDirectory } from '../api/me';
import { captureIdentity } from '../data/identity';
import { useResource } from '../data/use-resource';
import { MAX_VIEW_RECORDS } from '../shared/contract';
import { cardFields, choiceCard, recordChoice, type AppCardContext } from './model';

type Choices = Record<string, { id: string; label: string }[]>;
export function useAppChoices(context: AppCardContext | undefined) {
  const load = useCallback(async () => {
    const current = captureIdentity();
    const out: Choices = {};
    if (!context) return { ok: true as const, data: out };
    const { runtime, card } = context;
    const fields = cardFields(runtime, card, !!context.record);
    if (fields.some((f) => f.type === 'member')) {
      const members = await memberDirectory();
      if (!current()) return { ok: false as const, status: 0, code: 'cancelled', message: '' };
      if (!members.ok) return members;
      for (const field of fields.filter((f) => f.type === 'member'))
        out[field.id] = members.data.items.map((m) => ({ id: m.id, label: m.name }));
    }
    const queried = new Map<string, Choices[string]>();
    for (const field of context.record ? [] : fields.filter(recordChoice)) {
      const source = choiceCard(runtime, field);
      if (!source) continue;
      const cached = queried.get(source.id);
      if (cached) {
        out[field.id] = cached;
        continue;
      }
      const primary = runtime.base.tables.find((t) => t.id === source.table_id)?.fields.find((f) => f.is_primary);
      const options: Choices[string] = [];
      let cursor: string | undefined;
      let seen = 0;
      do {
        if (!current()) return { ok: false as const, status: 0, code: 'cancelled', message: '' };
        const result = await appCard(runtime.app.id, runtime.version, source.id, cursor);
        if (!result.ok) return result;
        if (result.data.kind !== 'records' || !result.data.data.items.length) break;
        seen += result.data.data.items.length;
        for (const record of result.data.data.items) {
          const title = primary && record.values[primary.id];
          if (typeof title === 'string' && title && !options.some((o) => o.id === record.id))
            options.push({ id: record.id, label: title });
        }
        cursor = result.data.data.next_cursor ?? undefined;
      } while (cursor && seen < MAX_VIEW_RECORDS);
      queried.set(source.id, options);
      out[field.id] = options;
    }
    return { ok: true as const, data: out };
  }, [context]);
  return useResource(load, ['records.changed', 'base.updated']);
}
