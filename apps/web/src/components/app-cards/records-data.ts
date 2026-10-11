/**
 * What a records-like card (records / kanban / calendar / gallery) draws from
 * its evaluated state: the gateway's rows as Tables records, the table's
 * role-readable fields, and the people named in the refs — one derivation
 * shared by the four renderers.
 */

import { useMemo } from 'react';
import type { AppCardQueryResult, AppRecordRefs, AppRecordRow } from '@greenhouse/types/apps';
import type { TableCardState } from '../table-cards';
import type { TableField, TableRecord, TableUserOption } from '../../lib/api/tables';
import {
  appRecordToTableRecord,
  appTableFields,
  cardTitle,
  EMPTY_REFS,
  pickFields,
  refsUsers,
  usersByIdOf,
  viewTable,
  type AppRecordsLikeCard,
  type AppViewTable,
} from './model';
import type { AppCardHost } from './types';

export interface AppRecordsData {
  title: string;
  table: AppViewTable | undefined;
  /** Every field of the table the role may read. */
  fields: TableField[];
  /** The card's own fields (`fieldIds`), in its order. */
  columns: TableField[];
  rows: AppRecordRow[];
  rowsById: ReadonlyMap<number, AppRecordRow>;
  records: TableRecord[];
  refs: AppRecordRefs;
  users: TableUserOption[];
  usersById: ReadonlyMap<string, TableUserOption>;
  total: number;
  nextCursor: string | null;
  /** A records answer arrived (an empty one included). */
  loaded: boolean;
}

export function recordsResult(
  state: TableCardState<AppCardQueryResult> | undefined,
): Extract<AppCardQueryResult, { kind: 'records' }> | undefined {
  return state?.result?.kind === 'records' ? state.result : undefined;
}

export function useAppRecordsResult(
  card: AppRecordsLikeCard,
  host: Pick<AppCardHost, 'view'>,
  state: TableCardState<AppCardQueryResult> | undefined,
): AppRecordsData {
  const result = recordsResult(state);
  const table = viewTable(host.view, card.source.tableId);
  return useMemo(() => {
    const fields = appTableFields(table);
    const rows = result?.records ?? [];
    const refs = result?.refs ?? EMPTY_REFS;
    const users = refsUsers(refs);
    return {
      title: cardTitle(card, host.view),
      table,
      fields,
      columns: pickFields(fields, card.fieldIds),
      rows,
      rowsById: new Map(rows.map((row) => [row.id, row])),
      records: rows.map((row) => appRecordToTableRecord(row, card.source.tableId)),
      refs,
      users,
      usersById: usersByIdOf(users),
      total: result?.total ?? 0,
      nextCursor: result?.nextCursor ?? null,
      loaded: result !== undefined,
    };
  }, [card, host.view, result, table]);
}
