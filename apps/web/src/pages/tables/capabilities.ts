/**
 * What the person on screen may do with one table — the client mirror of the
 * server's decision, so the UI never offers a change that would come back as a
 * 403 / 404. Built-in roles follow the role ladder; a custom role follows the
 * per-table view the server compiled for it (`getBase.access.tables`), which is
 * exact: the same compiler every record call runs. Row-level edit scopes are
 * not mirrored (a predicate per record); the server still refuses those.
 */

import { tableRoleAtLeast, type TableBaseAccessView } from '@greenhouse/types/table-access';

export interface TableCapabilities {
  /** Change records at all (inline edit, edit button, paste). */
  canEdit: boolean;
  canCreate: boolean;
  canDelete: boolean;
  /** Structure: fields, shared views, forms, automations (builder+; never a custom role). */
  canBuild: boolean;
  /** Personal views need a built-in editor (the server's split); a custom role reads shared views only. */
  canSaveView: boolean;
  canEditField(fieldId: number): boolean;
  /** Fields the role reads; undefined = every field (built-in roles). */
  readableFieldIds?: ReadonlySet<number>;
}

const NOTHING: TableCapabilities = Object.freeze({
  canEdit: false,
  canCreate: false,
  canDelete: false,
  canBuild: false,
  canSaveView: false,
  canEditField: () => false,
  readableFieldIds: new Set<number>(),
});

export function tableCapabilities(access: TableBaseAccessView, table: { id: number }): TableCapabilities {
  const { level } = access;
  if (level === 'none') return NOTHING;
  if (level !== 'custom') {
    const canEdit = tableRoleAtLeast(level, 'editor');
    return {
      canEdit,
      canCreate: canEdit,
      canDelete: canEdit,
      canBuild: tableRoleAtLeast(level, 'builder'),
      canSaveView: canEdit,
      canEditField: () => canEdit,
    };
  }
  const view = access.tables?.find((entry) => entry.tableId === table.id);
  if (!view) return NOTHING;
  const editable = new Set(view.editableFieldIds);
  return {
    canEdit: view.access === 'edit' && editable.size > 0,
    canCreate: view.canCreate,
    canDelete: view.canDelete,
    canBuild: false,
    // Personal views on a table the role can read (the server's deleteView / createView rule).
    canSaveView: true,
    canEditField: (fieldId) => editable.has(fieldId),
    readableFieldIds: new Set(view.readableFieldIds),
  };
}
