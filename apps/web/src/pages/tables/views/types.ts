/**
 * Contract between the view container (`../view-container.tsx`: schema, query,
 * paging, dialogs, record drawer, toolbar) and a view body (`./grid.tsx`,
 * `./kanban.tsx`, `./calendar.tsx`, `./gallery.tsx`). A body draws records and
 * turns gestures into these callbacks; it never writes on its own. The one
 * read a body makes itself is a group count (`./use-group-counts.ts`, the
 * grid's group headers and the kanban lane counts), over the same query.
 */

import type {
  TableFilterGroup,
  TableRecordValues,
  TableSort,
  TableSystemField,
  TableViewConfig,
} from '@greenhouse/types/tables';
import type { TableDefinition, TableField, TableRecord, TableUserOption, TableView } from '../../../lib/api/tables';

export interface TableViewPermissions {
  /** Edit records (Base editor+): inline edits, kanban / calendar drags. */
  canEdit: boolean;
  /** Create records (Base editor+): a kanban lane's "+", a click on a calendar day. */
  canCreate: boolean;
  /** Change structure — fields, shared views (Base builder+). */
  canBuild: boolean;
  /**
   * Change the view on screen: your own personal view needs editor, a shared
   * one builder (the split the server enforces). On the unsaved default view a
   * change goes through Save view.
   */
  canChangeView: boolean;
}

/** What the records on screen match, without paging — group counts aggregate over it. */
export interface TableViewQuery {
  where?: TableFilterGroup;
  filters?: TableFilterGroup[];
  search?: string;
}

/** A sortable column: a user field or a system column. */
export type TableSortTarget = TableField | TableSystemField;

export interface TableViewBodyProps {
  table: TableDefinition;
  /** The saved view on screen; `null` = the unsaved default grid. */
  view: TableView | null;
  config: TableViewConfig;
  /** Visible fields in display order (the view's `fieldIds` order). */
  fields: TableField[];
  /** Every active field of the table — lane, date and cover fields need not be visible. */
  schemaFields: TableField[];
  records: TableRecord[];
  /** Records the query matches; more than `records` when paged or capped. */
  total: number;
  query: TableViewQuery;
  loading: boolean;
  users: TableUserOption[];
  usersById: ReadonlyMap<string, TableUserOption>;
  sort: TableSort[] | undefined;
  permissions: TableViewPermissions;
  /** Calendar: the month on screen (`YYYY-MM`); the container queries its window. */
  calendarMonth: string;
  onCalendarMonthChange: (month: string) => void;
  onToggleSort: (target: TableSortTarget) => void;
  onOpenRecord: (record: TableRecord) => void;
  onEditRecord: (record: TableRecord) => void;
  onDeleteRecord: (record: TableRecord) => void;
  /** Open the new-record dialog with these values filled in (a kanban lane, a calendar day). */
  onCreateRecord: (values: TableRecordValues) => void;
  /** Save one field of one record (an inline edit, a drag between kanban lanes). */
  onCommitValue: (record: TableRecord, field: TableField, value: unknown) => Promise<void>;
  /** Save several fields of one record in one revision-checked write (a calendar move keeps the duration). */
  onCommitValues: (record: TableRecord, values: TableRecordValues) => Promise<void>;
  /** Paste a tab-separated matrix starting at this record row and visible column. */
  onPaste: (rowIndex: number, columnIndex: number, text: string) => void;
  onEditField: (field: TableField) => void;
  /** Persist a change to the view's config; on the unsaved default view this opens Save view first. */
  onUpdateViewConfig: (patch: Partial<TableViewConfig>) => Promise<void>;
  /** Open the view's settings (a kanban without lanes, a calendar without a date field). */
  onConfigureView: () => void;
}
