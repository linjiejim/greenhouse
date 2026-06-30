/**
 * API audit service — external API audit log persistence (PostgreSQL).
 */

import { eq, and, sql, desc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { apiAuditLog } from '../schema/index.js';
import type { ApiAuditLogRow, ApiClientChannel } from '../schema/api-client.js';

export interface ApiAuditLogInput {
  app_id: string;
  endpoint: string;
  method: string;
  session_id?: string;
  ext_user_id?: string;
  user_id?: string; // internal user the key is bound to (a2a / local-agent / cli)
  channel?: ApiClientChannel; // defaults to 'api' at the DB layer when omitted
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
  ext_user_id?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

/** External API audit log persistence. */
export function createApiAuditService(db: Db) {
  const service = {
    async record(input: ApiAuditLogInput): Promise<void> {
      await db.insert(apiAuditLog).values({
        app_id: input.app_id,
        endpoint: input.endpoint,
        method: input.method,
        session_id: input.session_id ?? null,
        ext_user_id: input.ext_user_id ?? null,
        user_id: input.user_id ?? null,
        ...(input.channel ? { channel: input.channel } : {}),
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
      if (opts?.ext_user_id) conditions.push(eq(apiAuditLog.ext_user_id, opts.ext_user_id));
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
