/**
 * The carry marker: one row the 3.x `migrate-from-1x` wrote into its target
 * before emptying anything (`completed_at` null) and completed as its very last
 * step. 4.0 no longer carries 1.x databases; it only reads the marker of a
 * database that was carried, and never writes or removes it. It lives in the
 * `drizzle` schema next to the migration journal, so it is not a public table.
 * A database never carried has no marker.
 *
 * Two readers: one over a raw postgres.js connection (migrate) and one over a
 * drizzle `Db` (the extension migration lane, which runs inside the provider and
 * must see the same transaction).
 */
import type postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import type { Db } from './client.js';

export const CARRY_MARKER_TABLE = 'drizzle.greenhouse_carry';

export interface CarryState {
  sourceVersion: string | null;
  startedAt: string;
  completedAt: string | null;
}

interface MarkerRow {
  source_version: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
}

function toState(row: MarkerRow | undefined): CarryState | null {
  if (!row) return null;
  return {
    sourceVersion: row.source_version,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

export async function readCarryState(sql: postgres.Sql): Promise<CarryState | null> {
  const [exists] = await sql<{ t: string | null }[]>`SELECT to_regclass(${CARRY_MARKER_TABLE})::text AS t`;
  if (!exists?.t) return null;
  const [row] = await sql<MarkerRow[]>`
    SELECT source_version, started_at, completed_at FROM drizzle.greenhouse_carry WHERE id = 1`;
  return toState(row);
}

/** The same marker read through a drizzle `Db` (or a transaction on one). */
export async function readCarryStateFromDb(db: Db): Promise<CarryState | null> {
  const [exists] = (await db.execute(dsql`SELECT to_regclass(${CARRY_MARKER_TABLE})::text AS t`)) as unknown as Array<{
    t: string | null;
  }>;
  if (!exists?.t) return null;
  const [row] = (await db.execute(
    dsql`SELECT source_version, started_at, completed_at FROM drizzle.greenhouse_carry WHERE id = 1`,
  )) as unknown as MarkerRow[];
  return toState(row);
}
