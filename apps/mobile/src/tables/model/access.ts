/**
 * What I may do in one table, from my Base workspace (`getBase.access`) — pure
 * (root vitest: ./access.test.ts). The server decides every write; the phone
 * only hides what it would refuse anyway (foundation spec §1 "前端按
 * getBase.access 收起不可编辑项"):
 *
 *  - owner / builder / editor: every non-computed field is editable, records
 *    can be created and deleted;
 *  - viewer: read only;
 *  - custom: the compiled per-table view (`access.tables[]`: editable fields,
 *    create / delete) — a table without one is not readable at all.
 */

import type { TableBaseAccessView } from '../../shared/table-access';
import type { TableBaseRole } from '../../shared/tables';
import { isComputed, type FieldLike } from './fields';

export interface TableAbilities {
  canCreate: boolean;
  canDelete: boolean;
  /** Fields I may write (computed fields never). */
  editable: Set<number>;
}

export const READ_ONLY: TableAbilities = Object.freeze({
  canCreate: false,
  canDelete: false,
  editable: new Set<number>(),
});

export function tableAbilities(
  workspace: { role: TableBaseRole; access?: TableBaseAccessView } | null | undefined,
  tableId: number,
  fields: readonly FieldLike[],
): TableAbilities {
  if (!workspace) return READ_ONLY;
  const level = workspace.access?.level ?? workspace.role;
  const writable = fields.filter((field) => !isComputed(field)).map((field) => field.id);
  if (level === 'owner' || level === 'builder' || level === 'editor') {
    return { canCreate: true, canDelete: true, editable: new Set(writable) };
  }
  if (level === 'custom') {
    const view = workspace.access?.tables?.find((table) => table.tableId === tableId);
    if (!view || view.access !== 'edit') return READ_ONLY;
    const allowed = new Set(view.editableFieldIds);
    return {
      canCreate: view.canCreate,
      canDelete: view.canDelete,
      editable: new Set(writable.filter((id) => allowed.has(id))),
    };
  }
  return READ_ONLY;
}

/** The role I read a Base as, for its badge (`custom` when a custom role decides). */
export function roleOf(workspace: { role: TableBaseRole; access?: TableBaseAccessView }): TableBaseRole | 'custom' {
  return workspace.access?.level === 'custom' ? 'custom' : workspace.role;
}
