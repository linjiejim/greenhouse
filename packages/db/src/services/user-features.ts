/**
 * User feature service — generic per-user feature gate (PostgreSQL).
 */

import { eq, and } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { userFeatures } from '../schema/index.js';

// config is NOT NULL since migration 0004 — the row derives cleanly now.
export type UserFeatureRow = typeof userFeatures.$inferSelect;

export interface UserFeatureInput {
  user_id: string;
  feature: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  granted_by?: string;
}

export function createUserFeatureService(db: Db) {
  const service = {
    /** Set a user's feature toggle (upsert: create or update). */
    async upsert(input: UserFeatureInput): Promise<UserFeatureRow> {
      const now = nowIso();
      const config = input.config ? JSON.stringify(input.config) : '{}';

      // Try update first
      const existing = await db
        .select()
        .from(userFeatures)
        .where(and(eq(userFeatures.user_id, input.user_id), eq(userFeatures.feature, input.feature)));

      if (existing.length > 0) {
        const rows = await db
          .update(userFeatures)
          .set({
            enabled: input.enabled ?? true,
            config,
            granted_by: input.granted_by ?? existing[0].granted_by,
            updated_at: now,
          })
          .where(and(eq(userFeatures.user_id, input.user_id), eq(userFeatures.feature, input.feature)))
          .returning();
        return rows[0]!;
      }

      const rows = await db
        .insert(userFeatures)
        .values({
          user_id: input.user_id,
          feature: input.feature,
          enabled: input.enabled ?? true,
          config,
          granted_by: input.granted_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return rows[0]!;
    },

    /** Check if a user has a specific feature enabled. */
    async isEnabled(userId: string, feature: string): Promise<boolean> {
      const rows = await db
        .select({ enabled: userFeatures.enabled })
        .from(userFeatures)
        .where(and(eq(userFeatures.user_id, userId), eq(userFeatures.feature, feature)));
      return rows.length > 0 && rows[0].enabled;
    },

    /** Get all user IDs that have a feature enabled. */
    async listEnabledUsers(feature: string): Promise<string[]> {
      const rows = await db
        .select({ user_id: userFeatures.user_id })
        .from(userFeatures)
        .where(and(eq(userFeatures.feature, feature), eq(userFeatures.enabled, true)));
      return rows.map((r) => r.user_id);
    },

    /** Get all feature toggles for a user. */
    async listByUser(userId: string): Promise<UserFeatureRow[]> {
      return db.select().from(userFeatures).where(eq(userFeatures.user_id, userId));
    },

    /** Get all user states for a feature (admin view). */
    async listByFeature(feature: string): Promise<UserFeatureRow[]> {
      return db.select().from(userFeatures).where(eq(userFeatures.feature, feature));
    },

    /** Delete a user's feature toggle. */
    async delete(userId: string, feature: string): Promise<boolean> {
      const result = await db
        .delete(userFeatures)
        .where(and(eq(userFeatures.user_id, userId), eq(userFeatures.feature, feature)))
        .returning();
      return result.length > 0;
    },
  };
  return service;
}

export type UserFeatureService = ReturnType<typeof createUserFeatureService>;
