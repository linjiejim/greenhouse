/** Shared audit persistence for MCP, Agent proxy, and LLM Relay traffic. */

import { eq, and, sql, desc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { apiAuditLog } from '../schema/index.js';
import type { ApiAuditLogRow, ApiAuditChannel } from '../schema/api-client.js';

export interface ApiAuditLogInput {
  app_id: string;
  endpoint: string;
  method: string;
  user_id?: string;
  channel: Exclude<ApiAuditChannel, 'api'>;
  status_code?: number;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  meta?: Record<string, unknown>;
  ip_address?: string;
  error?: string;
}

export interface ApiAuditListOpts {
  app_id?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

/** Internal integration audit persistence. */
export function createApiAuditService(db: Db) {
  const service = {
    async record(input: ApiAuditLogInput): Promise<void> {
      await db.insert(apiAuditLog).values({
        app_id: input.app_id,
        endpoint: input.endpoint,
        method: input.method,
        user_id: input.user_id ?? null,
        channel: input.channel,
        status_code: input.status_code ?? null,
        duration_ms: input.duration_ms ?? null,
        input_tokens: input.input_tokens ?? null,
        output_tokens: input.output_tokens ?? null,
        meta: JSON.stringify(input.meta ?? {}),
        ip_address: input.ip_address ?? null,
        error: input.error ?? null,
        created_at: nowIso(),
      });
    },

    async list(opts?: ApiAuditListOpts): Promise<ApiAuditLogRow[]> {
      const conditions = [];
      if (opts?.app_id) conditions.push(eq(apiAuditLog.app_id, opts.app_id));
      if (opts?.since) conditions.push(sql`created_at >= ${opts.since}`);

      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;

      let query = db.select().from(apiAuditLog);
      if (conditions.length > 0) {
        query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions)) as any;
      }
      return await (query as any).orderBy(desc(apiAuditLog.created_at)).limit(limit).offset(offset);
    },

    async count(opts?: { app_id?: string; since?: string }): Promise<number> {
      const conditions = [];
      if (opts?.app_id) conditions.push(eq(apiAuditLog.app_id, opts.app_id));
      if (opts?.since) conditions.push(sql`created_at >= ${opts.since}`);

      let query = db.select({ cnt: sql<number>`COUNT(*)` }).from(apiAuditLog);
      if (conditions.length > 0) {
        query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions)) as any;
      }
      const row = (await query)[0];
      return Number(row?.cnt ?? 0);
    },

    /** Get daily token usage for an API client. */
    async getDailyTokenUsage(appId: string): Promise<number> {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const result = await db.execute(sql`
        SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as total
        FROM api_audit_log
        WHERE app_id = ${appId} AND created_at >= ${todayStart.toISOString()}
      `);
      return Number((result as any[])[0]?.total ?? 0);
    },
  };
  return service;
}

export type ApiAuditService = ReturnType<typeof createApiAuditService>;
