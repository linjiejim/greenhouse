/**
 * User identity service — external SSO identities bound to internal accounts.
 *
 * One row per (provider, subject); a user binds at most one identity per
 * provider. See docs/specs/20260708-sso-identity-connectors.md.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { userIdentities } from '../schema/index.js';
import type { UserIdentityRow } from '../schema/user.js';

export interface UserIdentityInput {
  user_id: string;
  provider: string;
  subject: string;
  display_name?: string | null;
  avatar_url?: string | null;
  raw_profile?: string | null;
}

export function createUserIdentityService(db: Db) {
  const service = {
    async create(input: UserIdentityInput): Promise<UserIdentityRow> {
      const now = nowIso();
      const id = randomUUID();
      await db.insert(userIdentities).values({
        id,
        user_id: input.user_id,
        provider: input.provider,
        subject: input.subject,
        display_name: input.display_name ?? null,
        avatar_url: input.avatar_url ?? null,
        raw_profile: input.raw_profile ?? null,
        created_at: now,
        updated_at: now,
      });
      const rows = await db.select().from(userIdentities).where(eq(userIdentities.id, id));
      return rows[0]!;
    },

    async getByProviderSubject(provider: string, subject: string): Promise<UserIdentityRow | undefined> {
      const rows = await db
        .select()
        .from(userIdentities)
        .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)));
      return rows[0];
    },

    async getByUserAndProvider(userId: string, provider: string): Promise<UserIdentityRow | undefined> {
      const rows = await db
        .select()
        .from(userIdentities)
        .where(and(eq(userIdentities.user_id, userId), eq(userIdentities.provider, provider)));
      return rows[0];
    },

    async listByUser(userId: string): Promise<UserIdentityRow[]> {
      return await db
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.user_id, userId))
        .orderBy(userIdentities.created_at);
    },

    /** Refresh display fields + last_login_at after a successful SSO login. */
    async touchLogin(
      id: string,
      updates: { display_name?: string | null; avatar_url?: string | null; raw_profile?: string | null },
    ): Promise<void> {
      const set: Record<string, unknown> = { updated_at: nowIso(), last_login_at: nowIso() };
      if (updates.display_name !== undefined && updates.display_name !== null) set.display_name = updates.display_name;
      if (updates.avatar_url !== undefined && updates.avatar_url !== null) set.avatar_url = updates.avatar_url;
      if (updates.raw_profile !== undefined && updates.raw_profile !== null) set.raw_profile = updates.raw_profile;
      await db.update(userIdentities).set(set).where(eq(userIdentities.id, id));
    },

    async deleteByUserAndProvider(userId: string, provider: string): Promise<boolean> {
      const result = await db
        .delete(userIdentities)
        .where(and(eq(userIdentities.user_id, userId), eq(userIdentities.provider, provider)))
        .returning();
      return result.length > 0;
    },

    async countByUser(userId: string): Promise<number> {
      const rows = await db.select().from(userIdentities).where(eq(userIdentities.user_id, userId));
      return rows.length;
    },
  };
  return service;
}

export type UserIdentityService = ReturnType<typeof createUserIdentityService>;
