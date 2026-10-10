/**
 * Saved views (shared and personal). Config validation per view type arrives
 * with slice V (`normalizeViewConfig`).
 */

import { and, asc, eq, or } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { TableViewConfig, TableViewScope } from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import { tableViews } from '../../schema/index.js';
import type { TableViewRow } from '../../schema/tables.js';
import { TablesValidationError, trimmed, type TableRevisionResult } from './shared.js';

export interface UpdateTableViewInput {
  revision: number;
  name?: string;
  config?: TableViewConfig;
  position?: number;
}

export interface CreateTableViewInput {
  table_id: number;
  name: string;
  scope?: TableViewScope;
  owner_id?: string | null;
  config?: TableViewConfig;
  position?: number;
  created_by: string;
}

export function createTablesViews(db: Db) {
  const service = {
    async listViews(tableId: number, userId?: string): Promise<TableViewRow[]> {
      const visibility = userId
        ? or(eq(tableViews.scope, 'shared'), eq(tableViews.owner_id, userId))
        : eq(tableViews.scope, 'shared');
      return db
        .select()
        .from(tableViews)
        .where(and(eq(tableViews.table_id, tableId), visibility))
        .orderBy(asc(tableViews.position), asc(tableViews.id));
    },

    async getView(id: number, userId?: string): Promise<TableViewRow | undefined> {
      const visibility = userId ? or(eq(tableViews.scope, 'shared'), eq(tableViews.owner_id, userId)) : undefined;
      const rows = await db
        .select()
        .from(tableViews)
        .where(visibility ? and(eq(tableViews.id, id), visibility) : eq(tableViews.id, id))
        .limit(1);
      return rows[0];
    },

    async createView(input: CreateTableViewInput): Promise<TableViewRow> {
      if (input.scope === 'personal' && !input.owner_id) {
        throw new TablesValidationError('Personal views require owner_id');
      }
      const now = nowIso();
      const [row] = await db
        .insert(tableViews)
        .values({
          table_id: input.table_id,
          name: trimmed(input.name, 'View name', 120),
          type: 'grid',
          scope: input.scope ?? 'shared',
          owner_id: input.scope === 'personal' ? input.owner_id : null,
          config: JSON.stringify({ ...(input.config ?? {}), version: 1 } satisfies TableViewConfig),
          position: input.position ?? 0,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async updateView(
      id: number,
      patch: UpdateTableViewInput,
      userId?: string,
    ): Promise<TableRevisionResult<TableViewRow>> {
      const current = await service.getView(id, userId);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current.revision };
      }
      const values: Partial<TableViewRow> = {
        revision: patch.revision + 1,
        updated_at: nowIso(),
      };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'View name', 120);
      if (patch.config !== undefined) {
        values.config = JSON.stringify({ ...patch.config, version: 1 } satisfies TableViewConfig);
      }
      if (patch.position !== undefined) values.position = patch.position;
      const rows = await db
        .update(tableViews)
        .set(values)
        .where(and(eq(tableViews.id, id), eq(tableViews.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await service.getView(id, userId);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },
  };
  return service;
}
