/**
 * Custom profile service — user-created custom Agent profiles (PostgreSQL).
 *
 * Storage shape: relational shell columns (id/user_id/slug/name/is_shared/
 * base_profile_id/forked_from/timestamps) + a single `data` jsonb column
 * holding the rest of the manifest (`ProfileData`). Callers pass/receive the
 * already-parsed `data` object — no JSON string columns.
 */

import { eq, or, asc, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { ProfileData } from '@greenhouse/types/profile-manifest';

import type { Db } from '../client.js';
import * as schema from '../schema/index.js';
import type { CustomProfileRow } from '../schema/custom-profile.js';

export interface CustomProfileCreate {
  slug: string;
  user_id: string;
  name: string;
  base_profile_id?: string;
  is_shared?: boolean;
  forked_from?: string | null;
  data: ProfileData;
}

export interface CustomProfileUpdate {
  name?: string;
  base_profile_id?: string;
  is_shared?: boolean;
  /** Full replacement of the manifest payload (the route merges before calling). */
  data?: ProfileData;
}

/** User-created custom agent profiles. */
export function createCustomProfileService(db: Db) {
  const service = {
    async create(input: CustomProfileCreate): Promise<CustomProfileRow> {
      const now = nowIso();
      const [row] = await db
        .insert(schema.customProfiles)
        .values({
          slug: input.slug,
          user_id: input.user_id,
          name: input.name,
          base_profile_id: input.base_profile_id ?? 'default',
          is_shared: input.is_shared ?? false,
          forked_from: input.forked_from ?? null,
          data: input.data,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row;
    },

    async getById(id: number): Promise<CustomProfileRow | undefined> {
      const [row] = await db.select().from(schema.customProfiles).where(eq(schema.customProfiles.id, id)).limit(1);
      return row;
    },

    async getByUserSlug(userId: string, slug: string): Promise<CustomProfileRow | undefined> {
      const [row] = await db
        .select()
        .from(schema.customProfiles)
        .where(sql`${schema.customProfiles.user_id} = ${userId} AND ${schema.customProfiles.slug} = ${slug}`)
        .limit(1);
      return row;
    },

    /** List profiles visible to a user: own + shared by others. */
    async listForUser(userId: string): Promise<CustomProfileRow[]> {
      return db
        .select()
        .from(schema.customProfiles)
        .where(or(eq(schema.customProfiles.user_id, userId), eq(schema.customProfiles.is_shared, true)))
        .orderBy(asc(schema.customProfiles.name));
    },

    async update(id: number, updates: CustomProfileUpdate): Promise<CustomProfileRow | undefined> {
      const values: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.name !== undefined) values.name = updates.name;
      if (updates.base_profile_id !== undefined) values.base_profile_id = updates.base_profile_id;
      if (updates.is_shared !== undefined) values.is_shared = updates.is_shared;
      if (updates.data !== undefined) values.data = updates.data;

      const [row] = await db
        .update(schema.customProfiles)
        .set(values)
        .where(eq(schema.customProfiles.id, id))
        .returning();
      return row;
    },

    async delete(id: number): Promise<boolean> {
      const result = await db
        .delete(schema.customProfiles)
        .where(eq(schema.customProfiles.id, id))
        .returning({ id: schema.customProfiles.id });
      return result.length > 0;
    },

    async countByUser(userId: string): Promise<number> {
      const result = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.customProfiles)
        .where(eq(schema.customProfiles.user_id, userId));
      return result[0]?.count ?? 0;
    },
  };
  return service;
}

export type CustomProfileService = ReturnType<typeof createCustomProfileService>;
