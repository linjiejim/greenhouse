/**
 * API client service — external API client CRUD (PostgreSQL).
 */

import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { apiClients } from '../schema/index.js';
import type { ApiClientRow, ApiClientStatus, ApiClientChannel } from '../schema/api-client.js';

export interface ApiClientInput {
  app_id: string;
  app_name: string;
  api_key_hash: string;
  allowed_profiles?: string[];
  rate_limit_rpm?: number;
  rate_limit_rpd?: number;
  daily_token_limit?: number;
  meta?: Record<string, unknown>;
  user_id?: string; // A2A: 关联内部用户
  channel?: ApiClientChannel; // 'api' | 'a2a'
  created_by?: string;
}

export interface ApiClientUpdateInput {
  app_name?: string;
  status?: ApiClientStatus;
  allowed_profiles?: string[];
  rate_limit_rpm?: number;
  rate_limit_rpd?: number;
  daily_token_limit?: number;
  meta?: Record<string, unknown>;
  api_key_hash?: string; // for key rotation
}

/** External API client CRUD. */
export function createApiClientService(db: Db) {
  const service = {
    async create(input: ApiClientInput): Promise<ApiClientRow> {
      const now = nowIso();
      const id = randomUUID();
      await db.insert(apiClients).values({
        id,
        app_id: input.app_id.toLowerCase().trim(),
        app_name: input.app_name.trim(),
        api_key_hash: input.api_key_hash,
        allowed_profiles: JSON.stringify(input.allowed_profiles ?? ['default']),
        rate_limit_rpm: input.rate_limit_rpm ?? 60,
        rate_limit_rpd: input.rate_limit_rpd ?? 10000,
        daily_token_limit: input.daily_token_limit ?? 50_000_000,
        meta: JSON.stringify(input.meta ?? {}),
        user_id: input.user_id ?? null,
        channel: input.channel ?? 'api',
        created_by: input.created_by ?? null,
        created_at: now,
        updated_at: now,
      });
      const rows = await db.select().from(apiClients).where(eq(apiClients.id, id));
      return rows[0]!;
    },

    async getById(id: string): Promise<ApiClientRow | undefined> {
      const rows = await db.select().from(apiClients).where(eq(apiClients.id, id));
      return rows[0];
    },

    async getByAppId(appId: string): Promise<ApiClientRow | undefined> {
      const rows = await db.select().from(apiClients).where(eq(apiClients.app_id, appId.toLowerCase().trim()));
      return rows[0];
    },

    async getByKeyHash(hash: string): Promise<ApiClientRow | undefined> {
      const rows = await db
        .select()
        .from(apiClients)
        .where(and(eq(apiClients.api_key_hash, hash), eq(apiClients.status, 'active')));
      return rows[0];
    },

    async list(): Promise<ApiClientRow[]> {
      return await db.select().from(apiClients).orderBy(apiClients.created_at);
    },

    async listByUserId(userId: string): Promise<ApiClientRow[]> {
      return await db.select().from(apiClients).where(eq(apiClients.user_id, userId)).orderBy(apiClients.created_at);
    },

    async countByUserId(userId: string): Promise<number> {
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(apiClients)
        .where(eq(apiClients.user_id, userId));
      return Number(result[0]?.count ?? 0);
    },

    async update(id: string, updates: ApiClientUpdateInput): Promise<ApiClientRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.app_name !== undefined) set.app_name = updates.app_name.trim();
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.allowed_profiles !== undefined) set.allowed_profiles = JSON.stringify(updates.allowed_profiles);
      if (updates.rate_limit_rpm !== undefined) set.rate_limit_rpm = updates.rate_limit_rpm;
      if (updates.rate_limit_rpd !== undefined) set.rate_limit_rpd = updates.rate_limit_rpd;
      if (updates.daily_token_limit !== undefined) set.daily_token_limit = updates.daily_token_limit;
      if (updates.meta !== undefined) set.meta = JSON.stringify(updates.meta);
      if (updates.api_key_hash !== undefined) set.api_key_hash = updates.api_key_hash;

      await db.update(apiClients).set(set).where(eq(apiClients.id, id));
      return service.getById(id);
    },

    async delete(id: string): Promise<boolean> {
      const deleted = await db.delete(apiClients).where(eq(apiClients.id, id)).returning({ id: apiClients.id });
      return deleted.length > 0;
    },
  };
  return service;
}

export type ApiClientService = ReturnType<typeof createApiClientService>;
