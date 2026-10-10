import type { TableField } from '../../lib/api/tables';

/**
 * The view's visible fields in the order of its `fieldIds`; every field, in
 * schema order, when it lists none. Ids of archived or unreadable fields drop out.
 */
export function orderedViewFields(fields: TableField[], fieldIds: number[] | undefined): TableField[] {
  if (!fieldIds?.length) return fields;
  const byId = new Map(fields.map((field) => [field.id, field]));
  return fieldIds.map((id) => byId.get(id)).filter((field): field is TableField => field !== undefined);
}
