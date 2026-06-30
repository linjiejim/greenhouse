/**
 * Custom profile service — user-created custom Agent profiles (PostgreSQL).
 */

import { eq, or, asc, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import * as schema from '../schema/index.js';
import type { CustomProfileRow } from '../schema/custom-profile.js';

export interface CustomProfileInput {
  slug: string;
  user_id: string;
  name: string;
  description?: string;
  base_profile_id?: string;
  tools: string[];
  system_prompt: string;
  capabilities?: Array<{ icon: string; label: string; prompt: string }>;
  max_steps?: number;
  is_shared?: boolean;
  avatar?: Record<string, unknown>;
  forked_from?: string;
}

export interface CustomProfileUpdateInput {
  name?: string;
  description?: string | null;
  base_profile_id?: string;
  tools?: string[];
  system_prompt?: string;
  capabilities?: Array<{ icon: string; label: string; prompt: string }>;
  max_steps?: number;
  is_shared?: boolean;
  avatar?: Record<string, unknown>;
}

/** User-created custom agent profiles. */
export function createCustomProfileService(db: Db) {
  const service = {
    async create(input: CustomProfileInput): Promise<CustomProfileRow> {
      const now = nowIso();
      const [row] = await db
        .insert(schema.customProfiles)
        .values({
          slug: input.slug,
          user_id: input.user_id,
          name: input.name,
          description: input.description ?? null,
          base_profile_id: input.base_profile_id ?? 'default',
          tools: JSON.stringify(input.tools),
          system_prompt: input.system_prompt,
          capabilities: JSON.stringify(input.capabilities ?? []),
          max_steps: input.max_steps ?? 12,
          is_shared: input.is_shared ?? false,
          avatar: JSON.stringify(input.avatar ?? {}),
          forked_from: input.forked_from ?? null,
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

    async update(id: number, updates: CustomProfileUpdateInput): Promise<CustomProfileRow | undefined> {
      const values: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.name !== undefined) values.name = updates.name;
      if (updates.description !== undefined) values.description = updates.description;
      if (updates.base_profile_id !== undefined) values.base_profile_id = updates.base_profile_id;
      if (updates.tools !== undefined) values.tools = JSON.stringify(updates.tools);
      if (updates.system_prompt !== undefined) values.system_prompt = updates.system_prompt;
      if (updates.capabilities !== undefined) values.capabilities = JSON.stringify(updates.capabilities);
      if (updates.max_steps !== undefined) values.max_steps = updates.max_steps;
      if (updates.is_shared !== undefined) values.is_shared = updates.is_shared;
      if (updates.avatar !== undefined) values.avatar = JSON.stringify(updates.avatar);

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
