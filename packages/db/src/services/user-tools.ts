/**
 * User tool service — user ↔ tool assignment (Super assigns tools to users) (PostgreSQL).
 */

import { eq, and, inArray } from 'drizzle-orm';
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

    /** Check if a user has been assigned a specific tool. */
    async hasTool(userId: string, toolId: string): Promise<boolean> {
      const rows = await db
        .select({ tool_id: userTools.tool_id })
        .from(userTools)
        .where(and(eq(userTools.user_id, userId), eq(userTools.tool_id, toolId)));
      return rows.length > 0;
    },

    /** Batch-get tool assignments for multiple users (admin list page). */
    async getToolsByUsers(userIds: string[]): Promise<Map<string, string[]>> {
      if (userIds.length === 0) return new Map();
      const rows = await db
        .select({ user_id: userTools.user_id, tool_id: userTools.tool_id })
        .from(userTools)
        .where(inArray(userTools.user_id, userIds));

      const result = new Map<string, string[]>();
      for (const row of rows) {
        const existing = result.get(row.user_id) ?? [];
        existing.push(row.tool_id);
        result.set(row.user_id, existing);
      }
      return result;
    },
  };
  return service;
}

export type UserToolService = ReturnType<typeof createUserToolService>;
