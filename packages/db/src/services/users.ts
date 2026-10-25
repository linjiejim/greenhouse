/**
 * User service — internal user account CRUD (PostgreSQL).
 */

import { eq, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import type { UserPreferences } from '@greenhouse/types/preferences';
import { newId } from '../ids.js';
import { passwordLinks as accountPasswordLinks, authRefreshTokens as refreshTokens, users } from '../schema/index.js';
import type { UserRow, UserRole, UserStatus } from '../schema/identity.js';

export interface UserInput {
  email: string;
  password_hash: string;
  nickname: string;
  role: UserRole;
  status?: UserStatus;
  created_by?: string;
}

export interface UserUpdateInput {
  nickname?: string;
  role?: UserRole;
  status?: UserStatus;
  notes?: string | null;
  locale?: string;
}

function userUpdateSet(updates: UserUpdateInput): Record<string, unknown> {
  const set: Record<string, unknown> = { updated_at: nowIso() };
  if (updates.nickname !== undefined) set.nickname = updates.nickname;
  if (updates.role !== undefined) set.role = updates.role;
  if (updates.status !== undefined) set.status = updates.status;
  if (updates.notes !== undefined) set.notes = updates.notes;
  if (updates.locale !== undefined) set.locale = updates.locale;
  return set;
}

export function createUserService(db: Db) {
  const service = {
    async create(input: UserInput): Promise<UserRow> {
      const now = nowIso();
      const id = newId('user');
      await db.insert(users).values({
        id,
        email: input.email,
        password_hash: input.password_hash,
        nickname: input.nickname,
        role: input.role,
        status: input.status ?? 'active',
        created_by: input.created_by ?? null,
        created_at: now,
        updated_at: now,
      });
      const rows = await db.select().from(users).where(eq(users.id, id));
      return rows[0]!;
    },

    async getById(id: string): Promise<UserRow | undefined> {
      const rows = await db.select().from(users).where(eq(users.id, id));
      return rows[0];
    },

    async getByEmail(email: string): Promise<UserRow | undefined> {
      const rows = await db.select().from(users).where(eq(users.email, email));
      return rows[0];
    },

    async list(): Promise<UserRow[]> {
      return await db.select().from(users).orderBy(users.created_at);
    },

    async update(id: string, updates: UserUpdateInput): Promise<UserRow | undefined> {
      await db.update(users).set(userUpdateSet(updates)).where(eq(users.id, id));
      return service.getById(id);
    },

    /**
     * Apply an account update while permanently invalidating every login session.
     * Used for active → disabled so a token cannot revive after reactivation,
     * and so refresh rotation cannot race between status update and revocation.
     */
    async updateAndRevokeSessions(id: string, updates: UserUpdateInput): Promise<UserRow | undefined> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(users)
          .set({
            ...userUpdateSet(updates),
            auth_version: sql`${users.auth_version} + 1`,
          })
          .where(eq(users.id, id))
          .returning();
        const updated = rows[0];
        if (!updated) return undefined;

        await tx.delete(refreshTokens).where(eq(refreshTokens.user_id, id));
        await tx
          .update(accountPasswordLinks)
          .set({ revoked_at: nowIso() })
          .where(
            sql`${accountPasswordLinks.user_id} = ${id} AND ${accountPasswordLinks.consumed_at} IS NULL AND ${accountPasswordLinks.revoked_at} IS NULL`,
          );
        return updated;
      });
    },

    async updateLastLogin(id: string): Promise<void> {
      await db.update(users).set({ last_login_at: nowIso() }).where(eq(users.id, id));
    },

    /**
     * Replace a password and invalidate every previously issued login credential.
     *
     * The version bump and refresh-token deletion share one transaction. Any
     * refresh request racing this reset can only issue the old version, which
     * is rejected by subsequent access/refresh validation after commit.
     */
    async resetPasswordAndRevokeSessions(id: string, passwordHash: string): Promise<UserRow | undefined> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(users)
          .set({
            password_hash: passwordHash,
            status: sql`CASE WHEN ${users.status} IN ('invited', 'reset_required') THEN 'active' ELSE ${users.status} END`,
            auth_version: sql`${users.auth_version} + 1`,
            updated_at: nowIso(),
          })
          .where(eq(users.id, id))
          .returning();
        const updated = rows[0];
        if (!updated) return undefined;

        await tx.delete(refreshTokens).where(eq(refreshTokens.user_id, id));
        await tx
          .update(accountPasswordLinks)
          .set({ revoked_at: nowIso() })
          .where(
            sql`${accountPasswordLinks.user_id} = ${id} AND ${accountPasswordLinks.consumed_at} IS NULL AND ${accountPasswordLinks.revoked_at} IS NULL`,
          );
        return updated;
      });
    },

    /** The stored preferences blob (font scale); `{}` for an unknown user. */
    async getPreferences(id: string): Promise<UserPreferences> {
      const rows = await db.select({ preferences: users.preferences }).from(users).where(eq(users.id, id));
      return rows[0]?.preferences ?? {};
    },

    /**
     * Read-modify-write the preferences blob under the user's row lock, so a
     * browser and an agent writing different keys at once never drop each
     * other's change. `mutate` gets the current blob and returns the next one.
     */
    async mutatePreferences(
      id: string,
      mutate: (current: UserPreferences) => UserPreferences,
    ): Promise<UserPreferences | undefined> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ preferences: users.preferences })
          .from(users)
          .where(eq(users.id, id))
          .for('update');
        if (!rows[0]) return undefined;
        const next = mutate({ ...(rows[0].preferences ?? {}) });
        await tx.update(users).set({ preferences: next, updated_at: nowIso() }).where(eq(users.id, id));
        return next;
      });
    },

    async count(): Promise<number> {
      const row = (await db.select({ cnt: sql<number>`COUNT(*)` }).from(users))[0];
      return Number(row?.cnt ?? 0);
    },

    /** Hard-delete a user and cascade related data. */
    async delete(id: string): Promise<boolean> {
      // postgres-js exposes `count`, not `rowCount` — a successful delete used to
      // report false here (and surface as a 500). `.returning()` is driver-agnostic.
      const result = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
      return result.length > 0;
    },
  };
  return service;
}

export type UserService = ReturnType<typeof createUserService>;
