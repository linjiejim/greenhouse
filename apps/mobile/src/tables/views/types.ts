/**
 * What every Tables view body (./list, ./kanban, ./calendar, ./gallery) gets
 * from the table page: the schema's fields, which ones the view shows, how
 * values read, what I may do, and how to open / create a record.
 */

import type { TableField, TableRecord } from '../../api/tables';
import type { TableAbilities } from '../model/access';
import type { ValueLabels } from '../model/fields';
import type { useRecords } from '../use-records';

export interface ViewContext {
  tableId: number;
  fields: TableField[];
  /** The view's visible fields, in order (the primary field included when shown). */
  shown: TableField[];
  primary: TableField | undefined;
  labels: ValueLabels;
  abilities: TableAbilities;
  open: (record: TableRecord) => void;
  /** A new record, prefilled (field id → wire value: a lane, a calendar day). */
  create: (defaults?: Record<string, unknown>) => void;
  /** Space under the content (home indicator). */
  bottomInset: number;
}

export type RecordsData = ReturnType<typeof useRecords>;
