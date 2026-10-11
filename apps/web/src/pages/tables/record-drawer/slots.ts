/**
 * Slot contract of the record drawer.
 *
 * The drawer (sticky header + tab body) has two extension points, each filled
 * by exactly one slice in its own file so no slice edits the drawer itself:
 *
 *   ./activity-slot.tsx — `RECORD_ACTIVITY_TAB`, the Activity tab (slice C:
 *                          comments + change history).
 *   ./actions-slot.tsx  — `RecordActionsSlot`, controls under the header
 *                          (slice Au: automation buttons).
 *
 * `null` means "not shipped yet"; the drawer renders nothing for it.
 */

import type { ComponentType } from 'react';
import type { TableDefinition, TableField, TableRecord, TableUserOption } from '../../../lib/api/tables';
import type { TranslationKey } from '../../../lib/i18n';

export interface RecordDrawerSlotProps {
  table: Pick<TableDefinition, 'id' | 'base_id' | 'name'>;
  record: TableRecord;
  /** The table's fields the viewer may read, in schema order. */
  fields: TableField[];
  users: TableUserOption[];
  usersById: ReadonlyMap<string, TableUserOption>;
  /** The viewer may edit this record (Base editor+). */
  canEdit: boolean;
  /** Re-read the record and the page after a slot changed it (a button ran, a comment edited a mention…). */
  onRecordChanged: () => void;
}

export interface RecordDrawerTab {
  /** Stable tab key (`activity`). */
  key: string;
  labelKey: TranslationKey;
  Panel: ComponentType<RecordDrawerSlotProps>;
}
