/**
 * User profile service — user ↔ profile assignment (PostgreSQL).
 */

import { eq, and } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { userProfiles } from '../schema/index.js';

export function createUserProfileService(db: Db) {
  const service = {
    /** Get profile IDs assigned to a user. */
    async getProfiles(userId: string): Promise<string[]> {
      const rows = await db
        .select({ profile_id: userProfiles.profile_id })
        .from(userProfiles)
        .where(eq(userProfiles.user_id, userId));
      return rows.map((r: any) => r.profile_id);
    },

    /** Replace all profile assignments for a user. */
    async setProfiles(userId: string, profileIds: string[], assignedBy: string): Promise<void> {
      const now = nowIso();
      await db.transaction(async (tx: any) => {
        await tx.delete(userProfiles).where(eq(userProfiles.user_id, userId));
        for (const profileId of profileIds) {
          await tx.insert(userProfiles).values({
            user_id: userId,
            profile_id: profileId,
            assigned_by: assignedBy,
            assigned_at: now,
          });
        }
      });
    },

    /** Check if a user has access to a specific profile. */
    async hasProfile(userId: string, profileId: string): Promise<boolean> {
      const rows = await db
        .select({ profile_id: userProfiles.profile_id })
        .from(userProfiles)
        .where(and(eq(userProfiles.user_id, userId), eq(userProfiles.profile_id, profileId)));
      return rows.length > 0;
    },
  };
  return service;
}

export type UserProfileService = ReturnType<typeof createUserProfileService>;
