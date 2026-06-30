/**
 * User service — internal user account CRUD (PostgreSQL).
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { users } from '../schema/index.js';
import type { UserRow, UserRole, UserStatus } from '../schema/user.js';

export interface UserInput {
  email: string;
  password_hash: string;
  nickname: string;
  role: UserRole;
  daily_message_limit?: number;
  monthly_token_limit?: number;
  created_by?: string;
}

export interface UserUpdateInput {
  nickname?: string;
  role?: UserRole;
  status?: UserStatus;
  password_hash?: string;
  daily_message_limit?: number;
  monthly_token_limit?: number;
  notes?: string | null;
  locale?: string;
}

export function createUserService(db: Db) {
  const service = {
    async create(input: UserInput): Promise<UserRow> {
      const now = nowIso();
      const id = randomUUID();
      await db.insert(users).values({
        id,
        email: input.email,
        password_hash: input.password_hash,
        nickname: input.nickname,
        role: input.role,
        status: 'active',
        daily_message_limit: input.daily_message_limit ?? 200,
        monthly_token_limit: input.monthly_token_limit ?? 20000000,
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
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.nickname !== undefined) set.nickname = updates.nickname;
      if (updates.role !== undefined) set.role = updates.role;
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.password_hash !== undefined) set.password_hash = updates.password_hash;
      if (updates.daily_message_limit !== undefined) set.daily_message_limit = updates.daily_message_limit;
      if (updates.monthly_token_limit !== undefined) set.monthly_token_limit = updates.monthly_token_limit;
      if (updates.notes !== undefined) set.notes = updates.notes;
      if (updates.locale !== undefined) set.locale = updates.locale;

      await db.update(users).set(set).where(eq(users.id, id));
      return service.getById(id);
    },

    async updateLastLogin(id: string): Promise<void> {
      await db.update(users).set({ last_login_at: nowIso() }).where(eq(users.id, id));
    },

    async count(): Promise<number> {
      const row = (await db.select({ cnt: sql<number>`COUNT(*)` }).from(users))[0];
      return Number(row?.cnt ?? 0);
    },

    /** Hard-delete a user and cascade related data. */
    async delete(id: string): Promise<boolean> {
      const result = await db.delete(users).where(eq(users.id, id)).returning();
      return result.length > 0;
    },
  };
  return service;
}

export type UserService = ReturnType<typeof createUserService>;
