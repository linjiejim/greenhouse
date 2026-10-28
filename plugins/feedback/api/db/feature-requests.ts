import { feedback } from '../schema.js';
/**
 * Feature request service — feature request CRUD (PostgreSQL).
 *
 * Requests are `feedback` rows of kind 'request'; this facade keeps their own
 * shape (title / description / admin_note …) at the boundary.
 */

import { and, eq, gte, lt, sql, desc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/api/extension-kit';

import type { Db } from '@greenhouse/api/extension-kit';
import { newId } from '@greenhouse/api/extension-kit';

import type { FeedbackRow, REQUEST_PRIORITIES, REQUEST_STATUSES } from '../schema.js';

export type FeatureRequestStatus = (typeof REQUEST_STATUSES)[number];
export type FeatureRequestPriority = (typeof REQUEST_PRIORITIES)[number];

export interface FeatureRequestRow {
  id: string;
  title: string;
  description: string;
  submitted_by: string;
  status: FeatureRequestStatus;
  priority: FeatureRequestPriority;
  admin_note: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

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

function toRequest(row: FeedbackRow): FeatureRequestRow {
  return {
    id: row.id,
    title: row.title,
    description: row.body ?? '',
    submitted_by: row.submitted_by ?? '',
    status: row.status as FeatureRequestStatus,
    priority: (row.priority ?? 'normal') as FeatureRequestPriority,
    admin_note: row.note,
    session_id: row.session_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const isRequest = eq(feedback.kind, 'request');

export function createFeatureRequestService(db: Db) {
  const service = {
    async create(input: FeatureRequestInput): Promise<FeatureRequestRow> {
      const now = nowIso();
      const [inserted] = await db
        .insert(feedback)
        .values({
          id: newId('feedback'),
          kind: 'request',
          title: input.title,
          body: input.description,
          status: 'pending',
          submitted_by: input.submitted_by,
          session_id: input.session_id ?? null,
          priority: input.priority ?? 'normal',
          created_at: now,
          updated_at: now,
        })
        .returning();
      return toRequest(inserted!);
    },

    async getById(id: string): Promise<FeatureRequestRow | undefined> {
      const rows = await db
        .select()
        .from(feedback)
        .where(and(isRequest, eq(feedback.id, id)));
      return rows[0] ? toRequest(rows[0]) : undefined;
    },

    async list(opts?: FeatureRequestListOpts): Promise<FeatureRequestRow[]> {
      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;
      const conditions = [
        isRequest,
        ...(opts?.status ? [eq(feedback.status, opts.status)] : []),
        ...(opts?.submitted_by ? [eq(feedback.submitted_by, opts.submitted_by)] : []),
      ];
      const rows = await db
        .select()
        .from(feedback)
        .where(and(...conditions))
        .orderBy(desc(feedback.created_at), desc(feedback.id))
        .limit(limit)
        .offset(offset);
      return rows.map(toRequest);
    },

    async update(id: string, updates: FeatureRequestUpdateInput): Promise<FeatureRequestRow | undefined> {
      const set: Partial<typeof feedback.$inferInsert> = { updated_at: nowIso() };
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.priority !== undefined) set.priority = updates.priority;
      if (updates.admin_note !== undefined) set.note = updates.admin_note;

      await db
        .update(feedback)
        .set(set)
        .where(and(isRequest, eq(feedback.id, id)));
      return service.getById(id);
    },

    /** Requests submitted in a window, newest first. */
    async listCreatedBetween(input: { from: string; to: string; limit?: number }): Promise<FeatureRequestRow[]> {
      const rows = await db
        .select()
        .from(feedback)
        .where(and(isRequest, gte(feedback.created_at, input.from), lt(feedback.created_at, input.to)))
        .orderBy(desc(feedback.created_at), desc(feedback.id))
        .limit(input.limit ?? 10);
      return rows.map(toRequest);
    },

    /** Requests submitted in a window, counted by their current status. */
    async countCreatedBetweenByStatus(input: {
      from: string;
      to: string;
    }): Promise<Record<FeatureRequestStatus, number>> {
      const rows = await db
        .select({ status: feedback.status, cnt: sql<string>`count(*)` })
        .from(feedback)
        .where(and(isRequest, gte(feedback.created_at, input.from), lt(feedback.created_at, input.to)))
        .groupBy(feedback.status);
      const out: Record<FeatureRequestStatus, number> = { pending: 0, accepted: 0, rejected: 0, done: 0 };
      for (const row of rows) {
        if (row.status in out) out[row.status as FeatureRequestStatus] = Number(row.cnt);
      }
      return out;
    },

    async count(status?: FeatureRequestStatus): Promise<number> {
      const row = (
        await db
          .select({ cnt: sql<number>`COUNT(*)` })
          .from(feedback)
          .where(status ? and(isRequest, eq(feedback.status, status)) : isRequest)
      )[0];
      return Number(row?.cnt ?? 0);
    },
  };
  return service;
}

export type FeatureRequestService = ReturnType<typeof createFeatureRequestService>;
