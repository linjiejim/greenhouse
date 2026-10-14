import type { Base, BaseTable, Field, RecordValues, TableRecord, View, ViewConfig } from '@greenhouse/contract';
import type { ViewRecords } from '../../data/tables';
import type { CellLookups } from './model';

/** What every view of a table gets from the base page. */
export interface ViewProps {
  base: Base;
  table: BaseTable;
  /** The table's live fields, in the table's order. */
  fields: Field[];
  view: View;
  /** The view's settings now: saved, or the reader's unsaved changes. */
  config: ViewConfig;
  data: ViewRecords;
  lookups: CellLookups;
  /** May change records (editors and up). */
  canEdit: boolean;
  /** May change fields and shared views (builders and up). */
  canBuild: boolean;
  narrow: boolean;
  onOpen(recordId: string): void;
  /** Saves values of a record; a conflict with another change is handled there. */
  onChange(record: TableRecord, values: RecordValues): Promise<void>;
  /** Makes a record with these values; null when it failed (the reason is shown there). */
  onCreate(values: RecordValues): Promise<TableRecord | null>;
  /** Changes the view's settings (saved when the reader may, else kept for this session). */
  onConfig(next: ViewConfig): void;
  /** Opens the field editor: a new field, or one to change. */
  onEditField(field?: Field): void;
}
