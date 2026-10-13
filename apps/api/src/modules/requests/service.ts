/**
 * "Needs you": the one request model. A request is decided once, by the member it is for, with
 * a compare-and-set from pending; a second decision or an expired card answers 409. What the
 * decision does next (run the approved tool, wake the Agent) belongs to the engine.
 */

import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { NeedsYou, Page } from '@greenhouse/contract';
import { getDb, newId, requests, type NeedsYouRequest, type RequestKind, type RequestStatus } from '@greenhouse/db';
import { conflict, notFound } from '../../http/errors.js';
import { decodeCursor, toPage } from '../../http/pagination.js';
import type { Hub } from '../../realtime/hub.js';
import type { NotificationsService } from '../notifications/service.js';

export interface CreateRequest {
  memberId: string;
  kind: RequestKind;
  subject: string;
  /** The card's heading in the member's language. */
  title: string;
  /** What the card shows. Never secrets. */
  payload: Record<string, unknown>;
  conversationId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  agentId?: string | null;
  /** Default 24 hours. */
  expiresInMs?: number;
}

export const toRequest = (row: NeedsYouRequest): NeedsYou => ({
  id: row.id,
  kind: row.kind,
  subject: row.subject,
  status: row.status,
  conversation_id: row.conversationId,
  run_id: row.runId,
  agent_id: row.agentId,
  title: typeof row.payload.title === 'string' ? row.payload.title : '',
  payload: row.payload,
  result: row.result,
  expires_at: row.expiresAt,
  decided_at: row.decidedAt,
  created_at: row.createdAt,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export function createRequestsService(deps: { hub: Hub; notifications: NotificationsService }) {
  const announce = (row: NeedsYouRequest) =>
    deps.hub.publish([row.memberId], {
      type: 'request.updated',
      data: { request_id: row.id, status: row.status, conversation_id: row.conversationId },
    });

  return {
    async create(input: CreateRequest): Promise<NeedsYouRequest> {
      const [row] = await getDb()
        .insert(requests)
        .values({
          id: newId('request'),
          memberId: input.memberId,
          kind: input.kind,
          subject: input.subject,
          payload: { ...input.payload, title: input.title },
          conversationId: input.conversationId ?? null,
          runId: input.runId ?? null,
          stepId: input.stepId ?? null,
          agentId: input.agentId ?? null,
          expiresAt: new Date(Date.now() + (input.expiresInMs ?? DAY_MS)).toISOString(),
        })
        .returning();
      await deps.notifications.publish({
        memberId: input.memberId,
        kind: 'request',
        title: input.title,
        targetType: input.conversationId ? 'conversation' : 'request',
        targetId: input.conversationId ?? row!.id,
        requestId: row!.id,
        runId: input.runId ?? undefined,
        agentId: input.agentId ?? undefined,
        payload: { category: 'needs_you', kind: input.kind },
        dedupeKey: `request:${row!.id}`,
      });
      announce(row!);
      return row!;
    },

    async list(
      memberId: string,
      query: { state: 'pending' | 'all'; conversation_id?: string; cursor?: string; limit: number },
    ): Promise<Page<NeedsYou>> {
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(requests)
        .where(
          and(
            eq(requests.memberId, memberId),
            query.state === 'pending' ? eq(requests.status, 'pending') : undefined,
            query.conversation_id ? eq(requests.conversationId, query.conversation_id) : undefined,
            before ? lt(requests.id, before) : undefined,
          ),
        )
        .orderBy(desc(requests.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, toRequest);
    },

    async get(memberId: string, id: string): Promise<NeedsYouRequest> {
      const [row] = await getDb()
        .select()
        .from(requests)
        .where(and(eq(requests.id, id), eq(requests.memberId, memberId)));
      if (!row) throw notFound('Request');
      return row;
    },

    /** The one way a request is decided: from pending, before it expires, exactly once. */
    async settle(
      memberId: string,
      id: string,
      outcome: { status: Exclude<RequestStatus, 'pending' | 'expired'>; result: Record<string, unknown> },
    ): Promise<NeedsYouRequest> {
      const [row] = await getDb()
        .update(requests)
        .set({
          status: outcome.status,
          result: outcome.result,
          decidedBy: memberId,
          decidedAt: sql`now()`,
          version: sql`${requests.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(requests.id, id),
            eq(requests.memberId, memberId),
            eq(requests.status, 'pending'),
            or(isNull(requests.expiresAt), gt(requests.expiresAt, new Date().toISOString())),
          ),
        )
        .returning();
      if (!row) {
        const current = await this.get(memberId, id);
        if (current.status === 'pending') throw conflict('request_expired', 'This card has expired.');
        throw conflict('request_settled', 'This card was already decided.');
      }
      await deps.notifications.markRequestRead(id);
      announce(row);
      return row;
    },

    /** Pending requests past their time become expired; returns them for follow-up. */
    async expireDue(): Promise<NeedsYouRequest[]> {
      const rows = await getDb()
        .update(requests)
        .set({ status: 'expired', updatedAt: sql`now()`, version: sql`${requests.version} + 1` })
        .where(and(eq(requests.status, 'pending'), lt(requests.expiresAt, new Date().toISOString())))
        .returning();
      for (const row of rows) {
        await deps.notifications.markRequestRead(row.id);
        announce(row);
      }
      return rows;
    },

    /** Cards of a run that will not continue (stopped, failed) can no longer be decided. */
    async cancelForRun(runId: string): Promise<void> {
      const rows = await getDb()
        .update(requests)
        .set({ status: 'canceled', updatedAt: sql`now()`, version: sql`${requests.version} + 1` })
        .where(and(eq(requests.runId, runId), eq(requests.status, 'pending')))
        .returning();
      for (const row of rows) {
        await deps.notifications.markRequestRead(row.id);
        announce(row);
      }
    },
  };
}

export type RequestsService = ReturnType<typeof createRequestsService>;
