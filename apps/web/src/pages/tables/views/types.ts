/**
 * Contract between the view container (`../view-container.tsx`: schema, query,
 * paging, dialogs, record drawer, toolbar) and a view body (`./grid.tsx`, and
 * slice V's kanban / calendar / gallery). A body only draws records and turns
 * gestures into these callbacks; it never fetches or writes on its own.
 */

import type { TableSort, TableViewConfig } from '@greenhouse/types/tables';
import type { TableDefinition, TableField, TableRecord, TableUserOption, TableView } from '../../../lib/api/tables';

export interface TableViewPermissions {
  /** Edit records (Base editor+). */
  canEdit: boolean;
  /** Change structure — fields, shared views (Base builder+). */
  canBuild: boolean;
  /**
   * Change the view on screen: your own personal view needs editor, a shared
   * one builder (the split the server enforces). On the unsaved default view a
   * change goes through Save view.
   */
  canChangeView: boolean;
  /**
   * Per field: may this person write it? A custom role edits only some fields
   * (`tableCapabilities`); omitted = every field `canEdit` covers.
   */
  canEditField?: (fieldId: number) => boolean;
  /** Delete records. Omitted = `canEdit`. */
  canDelete?: boolean;
}

export interface TableViewBodyProps {
  table: TableDefinition;
  /** The saved view on screen; `null` = the unsaved default grid. */
  view: TableView | null;
  config: TableViewConfig;
  /** Visible fields in display order (the view's `fieldIds` order). */
  fields: TableField[];
  records: TableRecord[];
  loading: boolean;
  users: TableUserOption[];
  usersById: ReadonlyMap<string, TableUserOption>;
  sort: TableSort[] | undefined;
  permissions: TableViewPermissions;
  onToggleSort: (field: TableField) => void;
  onOpenRecord: (record: TableRecord) => void;
  onEditRecord: (record: TableRecord) => void;
  onDeleteRecord: (record: TableRecord) => void;
  /** Save one field of one record (inline edit, a drag between kanban lanes, a calendar move). */
  onCommitValue: (record: TableRecord, field: TableField, value: unknown) => Promise<void>;
  /** Paste a tab-separated matrix starting at this record row and visible column. */
  onPaste: (rowIndex: number, columnIndex: number, text: string) => void;
  onEditField: (field: TableField) => void;
  /** Persist a change to the view's config; on the unsaved default view this opens Save view first. */
  onUpdateViewConfig: (patch: Partial<TableViewConfig>) => Promise<void>;
}
