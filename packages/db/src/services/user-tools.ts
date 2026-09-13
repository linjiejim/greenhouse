/**
 * User tool service — user ↔ tool assignment (Super assigns tools to users) (PostgreSQL).
 */

import { eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { userTools } from '../schema/index.js';

export function createUserToolService(db: Db) {
  const service = {
    /** Get tool IDs assigned to a user. */
    async getTools(userId: string): Promise<string[]> {
      const rows = await db.select({ tool_id: userTools.tool_id }).from(userTools).where(eq(userTools.user_id, userId));
      return rows.map((r: any) => r.tool_id);
    },

    /** Replace all tool assignments for a user. */
    async setTools(userId: string, toolIds: string[], assignedBy: string): Promise<void> {
      const now = nowIso();
      await db.transaction(async (tx: any) => {
        await tx.delete(userTools).where(eq(userTools.user_id, userId));
        for (const toolId of toolIds) {
          await tx.insert(userTools).values({
            user_id: userId,
            tool_id: toolId,
            assigned_by: assignedBy,
            assigned_at: now,
          });
        }
      });
    },
  };
  return service;
}

export type UserToolService = ReturnType<typeof createUserToolService>;
