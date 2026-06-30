/**
 * Feature request service — feature request CRUD (PostgreSQL).
 */

import { eq, sql, desc } from 'drizzle-orm';
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

      if (opts?.status) {
        return await db
          .select()
          .from(featureRequests)
          .where(eq(featureRequests.status, opts.status))
          .orderBy(desc(featureRequests.created_at))
          .limit(limit)
          .offset(offset);
      }
      return await db
        .select()
        .from(featureRequests)
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
