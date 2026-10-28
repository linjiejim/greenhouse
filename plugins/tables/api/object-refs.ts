import { getPlatformRuntime, userHasFeature, type ObjectRefSource } from '@greenhouse/api/extension-kit';
import { tablesResource } from './platform/application.js';
import { services } from './services.js';
const clip = (s: string) => (s.length > 200 ? s.slice(0, 199) + '…' : s);
function displayValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}
export const recordObjectRef: ObjectRefSource['resolve'] = async (ref, r) => {
  const hidden = { title: null };
  if (ref.type !== 'record') return hidden;
  if (!(await userHasFeature(r.user.id, r.user.role, 'tables', r.db))) return hidden;
  const result = await getPlatformRuntime().dispatch({
    actor: r.actor,
    appId: 'tables',
    actionId: 'getRecord',
    payload: { tableId: ref.tableId, recordId: ref.id },
    resource: tablesResource('getRecord', { tableId: ref.tableId, recordId: ref.id }),
  });
  if (!result.ok) return hidden;
  const [table, fields] = await Promise.all([
    services(r.db).tables.getTable(ref.tableId),
    services(r.db).tables.listFields(ref.tableId),
  ]);
  if (!table || (ref.baseId !== null && table.base_id !== ref.baseId)) return hidden;
  const record = (result.data as { record?: { values?: Record<string, unknown> } }).record;
  const primary = fields.find((field) => field.is_primary) ?? fields[0];
  const value = primary ? displayValue(record?.values?.[String(primary.id)]) : null;
  return { title: clip(value ?? `#${ref.id}`) };
};
