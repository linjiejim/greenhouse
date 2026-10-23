/**
 * Feature request service — feature request CRUD (PostgreSQL).
 */

import { and, eq, gte, lt, sql, desc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { featureRequests } from '../schema/index.js';
import type { FeatureRequestRow, FeatureRequestStatus, FeatureRequestPriority } from '../schema/feature-request.js';

export interface FeatureRequestInput {
  title: string;
  description: string;
  submitted_by: string;
  session_id?: string;
  priority?: FeatureRequestPriority;
}

export interface FeatureRequestUpdateInput {
  status?: FeatureRequestStatus;
  priority?: FeatureRequestPriority;
  admin_note?: string;
}

export interface FeatureRequestListOpts {
  status?: FeatureRequestStatus;
  /** Only the requests one member submitted. */
  submitted_by?: string;
  limit?: number;
  offset?: number;
}

export function createFeatureRequestService(db: Db) {
  const service = {
    async create(input: FeatureRequestInput): Promise<FeatureRequestRow> {
      const now = nowIso();
      const [inserted] = await db
        .insert(featureRequests)
        .values({
          title: input.title,
          description: input.description,
          submitted_by: input.submitted_by,
          session_id: input.session_id ?? null,
          priority: input.priority ?? 'normal',
          created_at: now,
          updated_at: now,
        })
        .returning();
      return inserted!;
    },

    async getById(id: number): Promise<FeatureRequestRow | undefined> {
      const rows = await db.select().from(featureRequests).where(eq(featureRequests.id, id));
      return rows[0];
    },

    async list(opts?: FeatureRequestListOpts): Promise<FeatureRequestRow[]> {
      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;
      const conditions = [
        ...(opts?.status ? [eq(featureRequests.status, opts.status)] : []),
        ...(opts?.submitted_by ? [eq(featureRequests.submitted_by, opts.submitted_by)] : []),
      ];
      return await db
        .select()
        .from(featureRequests)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(featureRequests.created_at))
        .limit(limit)
        .offset(offset);
    },

    async update(id: number, updates: FeatureRequestUpdateInput): Promise<FeatureRequestRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.priority !== undefined) set.priority = updates.priority;
      if (updates.admin_note !== undefined) set.admin_note = updates.admin_note;

      await db.update(featureRequests).set(set).where(eq(featureRequests.id, id));
      return service.getById(id);
    },

    /** Requests submitted in a window, newest first. */
    async listCreatedBetween(input: { from: string; to: string; limit?: number }): Promise<FeatureRequestRow[]> {
      return await db
        .select()
        .from(featureRequests)
        .where(and(gte(featureRequests.created_at, input.from), lt(featureRequests.created_at, input.to)))
        .orderBy(desc(featureRequests.created_at))
        .limit(input.limit ?? 10);
    },

    /** Requests submitted in a window, counted by their current status. */
    async countCreatedBetweenByStatus(input: {
      from: string;
      to: string;
    }): Promise<Record<FeatureRequestStatus, number>> {
      const rows = await db
        .select({ status: featureRequests.status, cnt: sql<string>`count(*)` })
        .from(featureRequests)
        .where(and(gte(featureRequests.created_at, input.from), lt(featureRequests.created_at, input.to)))
        .groupBy(featureRequests.status);
      const out: Record<FeatureRequestStatus, number> = { pending: 0, accepted: 0, rejected: 0, done: 0 };
      for (const row of rows) out[row.status] = Number(row.cnt);
      return out;
    },

    async count(status?: FeatureRequestStatus): Promise<number> {
      if (status) {
        const row = (
          await db
            .select({ cnt: sql<number>`COUNT(*)` })
            .from(featureRequests)
            .where(eq(featureRequests.status, status))
        )[0];
        return Number(row?.cnt ?? 0);
      }
      const row = (await db.select({ cnt: sql<number>`COUNT(*)` }).from(featureRequests))[0];
      return Number(row?.cnt ?? 0);
    },
  };
  return service;
}

export type FeatureRequestService = ReturnType<typeof createFeatureRequestService>;
