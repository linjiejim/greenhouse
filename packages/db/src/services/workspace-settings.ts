/**
 * Workspace settings service (PostgreSQL).
 *
 * Thin key-value storage over `workspace_settings`. Encryption/decryption of
 * secret values happens in the API layer (apps/api/src/settings/) — this
 * service stores whichever column it is handed, and enforces the "exactly one
 * of value / value_enc" invariant on upsert.
 */

import { eq, asc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { workspaceSettings } from '../schema/index.js';
import type { WorkspaceSettingRow } from '../schema/workspace-setting.js';

export type WorkspaceSettingWrite =
  | { value: unknown; value_enc?: undefined }
  | { value?: undefined; value_enc: string };

export function createWorkspaceSettingService(db: Db) {
  const service = {
    async list(): Promise<WorkspaceSettingRow[]> {
      return await db.select().from(workspaceSettings).orderBy(asc(workspaceSettings.key));
    },

    async get(key: string): Promise<WorkspaceSettingRow | undefined> {
      const rows = await db.select().from(workspaceSettings).where(eq(workspaceSettings.key, key));
      return rows[0];
    },

    /** Upsert one key. Pass `value` for plain settings, `value_enc` for secrets. */
    async set(key: string, write: WorkspaceSettingWrite, updatedBy?: string): Promise<WorkspaceSettingRow> {
      const now = nowIso();
      const row = {
        key,
        value: write.value_enc !== undefined ? null : (write.value ?? null),
        value_enc: write.value_enc ?? null,
        updated_by: updatedBy ?? null,
        updated_at: now,
      };
      await db
        .insert(workspaceSettings)
        .values(row)
        .onConflictDoUpdate({
          target: workspaceSettings.key,
          set: {
            value: row.value,
            value_enc: row.value_enc,
            updated_by: row.updated_by,
            updated_at: now,
          },
        });
      return (await service.get(key))!;
    },

    /** Remove the row — the setting falls back to its env var / default. */
    async clear(key: string): Promise<boolean> {
      const deleted = await db
        .delete(workspaceSettings)
        .where(eq(workspaceSettings.key, key))
        .returning({ key: workspaceSettings.key });
      return deleted.length > 0;
    },
  };
  return service;
}

export type WorkspaceSettingService = ReturnType<typeof createWorkspaceSettingService>;
