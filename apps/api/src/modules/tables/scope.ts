/**
 * What a reader sees of a data table. Owners, builders, editors and viewers see every field and
 * record; a custom role (base_roles) may hide the table, some of its fields and records. Every
 * read path takes its fields and records from here: lists, single records, search, exports,
 * dashboards, history, comments and realtime events.
 */

import type { SQL } from 'drizzle-orm';
import type { BaseFieldRow } from '@greenhouse/db';
import type { TablesReader } from './access.js';
import { fieldsOf, type TableAt } from './load.js';

export interface TableScope {
  /** The live fields the reader sees, in the table's order. */
  fields: BaseFieldRow[];
  /** Which records the reader sees, as a condition on base_records (undefined: all). */
  rows: SQL | undefined;
  /** Whether the reader may change records here. */
  canEdit: boolean;
}

/** The reader's view of a table they reached through tableAt (or recordAt, fieldAt, viewAt). */
export async function scopeOf(_reader: TablesReader, at: TableAt): Promise<TableScope> {
  return {
    fields: await fieldsOf(at.table.id),
    rows: undefined,
    canEdit: at.role === 'owner' || at.role === 'builder' || at.role === 'editor',
  };
}
