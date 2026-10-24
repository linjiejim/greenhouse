/**
 * Per-member feature switches — `user_grants` rows with kind = 'feature'.
 *
 * Resolution (super → all on; row → row.enabled; no row → the flag's default)
 * lives in `apps/api/src/auth/features.ts`; this service only stores rows.
 */

import { and, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { userGrants } from '../schema/index.js';

export interface UserFeatureRow {
  user_id: string;
  feature: string;
  enabled: boolean;
  config: Record<string, unknown>;
  granted_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserFeatureInput {
  user_id: string;
  feature: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  granted_by?: string;
}

const featureColumns = {
  user_id: userGrants.user_id,
  feature: userGrants.key,
  enabled: userGrants.enabled,
  config: userGrants.config,
  granted_by: userGrants.granted_by,
  created_at: userGrants.created_at,
  updated_at: userGrants.updated_at,
};

const isFeature = eq(userGrants.kind, 'feature');

export function createUserFeatureService(db: Db) {
  const service = {
    async upsert(input: UserFeatureInput): Promise<UserFeatureRow> {
      const now = nowIso();
      const rows = await db
        .insert(userGrants)
        .values({
          user_id: input.user_id,
          kind: 'feature',
          key: input.feature,
          enabled: input.enabled ?? true,
          config: input.config ?? {},
          granted_by: input.granted_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [userGrants.user_id, userGrants.kind, userGrants.key],
          set: {
            enabled: input.enabled ?? true,
            config: input.config ?? {},
            ...(input.granted_by !== undefined ? { granted_by: input.granted_by } : {}),
            updated_at: now,
          },
        })
        .returning(featureColumns);
      return rows[0]!;
    },

    async isEnabled(userId: string, feature: string): Promise<boolean> {
      const rows = await db
        .select({ enabled: userGrants.enabled })
        .from(userGrants)
        .where(and(eq(userGrants.user_id, userId), isFeature, eq(userGrants.key, feature)));
      return rows.length > 0 && rows[0]!.enabled;
    },

    async listEnabledUsers(feature: string): Promise<string[]> {
      const rows = await db
        .select({ user_id: userGrants.user_id })
        .from(userGrants)
        .where(and(isFeature, eq(userGrants.key, feature), eq(userGrants.enabled, true)));
      return rows.map((r) => r.user_id);
    },

    async listByUser(userId: string): Promise<UserFeatureRow[]> {
      return db
        .select(featureColumns)
        .from(userGrants)
        .where(and(eq(userGrants.user_id, userId), isFeature));
    },

    async listByFeature(feature: string): Promise<UserFeatureRow[]> {
      return db
        .select(featureColumns)
        .from(userGrants)
        .where(and(isFeature, eq(userGrants.key, feature)));
    },

    async delete(userId: string, feature: string): Promise<boolean> {
      const result = await db
        .delete(userGrants)
        .where(and(eq(userGrants.user_id, userId), isFeature, eq(userGrants.key, feature)))
        .returning({ key: userGrants.key });
      return result.length > 0;
    },
  };
  return service;
}

export type UserFeatureService = ReturnType<typeof createUserFeatureService>;
