/**
 * Opt-in tool assignments — `user_grants` rows with kind = 'tool'.
 */

import { and, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { userGrants } from '../schema/index.js';

export function createUserToolService(db: Db) {
  const service = {
    async getTools(userId: string): Promise<string[]> {
      const rows = await db
        .select({ key: userGrants.key })
        .from(userGrants)
        .where(and(eq(userGrants.user_id, userId), eq(userGrants.kind, 'tool'), eq(userGrants.enabled, true)));
      return rows.map((row) => row.key);
    },

    async setTools(userId: string, toolIds: string[], assignedBy: string): Promise<void> {
      const now = nowIso();
      await db.transaction(async (tx) => {
        await tx.delete(userGrants).where(and(eq(userGrants.user_id, userId), eq(userGrants.kind, 'tool')));
        const unique = [...new Set(toolIds)];
        if (unique.length === 0) return;
        await tx.insert(userGrants).values(
          unique.map((toolId) => ({
            user_id: userId,
            kind: 'tool' as const,
            key: toolId,
            enabled: true,
            granted_by: assignedBy,
            created_at: now,
            updated_at: now,
          })),
        );
      });
    },
  };
  return service;
}

export type UserToolService = ReturnType<typeof createUserToolService>;
