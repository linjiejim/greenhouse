import { countActive } from '../usage/counts.js';
/**
 * "Needs you": the one request model. A request is decided once, by the member it is for, with
 * a compare-and-set from pending; a second decision or an expired card answers 409. What the
 * decision does next (run the approved tool, wake the Agent) belongs to the engine: settling and
 * expiring write a `request_decided` job in the same transaction, so a decision survives a crash
 * between the click and its execution, and the engine's worker is woken once it commits.
 */

import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { NeedsYou, Page } from '@greenhouse/contract';
import {
  getDb,
  newId,
  requests,
  runs,
  transaction,
  type NeedsYouRequest,
  type RequestKind,
  type RequestStatus,
} from '@greenhouse/db';
import { conflict, notFound } from '../../http/errors.js';
import { enqueueJob } from '../../jobs.js';
import { decodeCursor, toPage } from '../../http/pagination.js';
import type { Hub } from '../../realtime/hub.js';
import type { NotificationsService } from '../notifications/service.js';
import type { ApprovalsService } from '../agents/approvals.js';

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

/** The job that carries out a decision (or an expiry): one per request, ever. */
export const DECISION_JOB = 'request_decided';

export function createRequestsService(deps: {
  hub: Hub;
  notifications: NotificationsService;
  /** A decision committed: the engine's worker takes it now rather than at its next poll. */
  decided: () => void;
  approvals?: ApprovalsService;
  display?: (input: CreateRequest) => Promise<CreateRequest>;
}) {
  const announce = (row: NeedsYouRequest) =>
    deps.hub.publish([row.memberId], {
      type: 'request.updated',
      data: { request_id: row.id, status: row.status, conversation_id: row.conversationId },
    });

  /** Joins the open transaction: the job commits with the decision. */
  const queueDecision = (row: NeedsYouRequest) =>
    enqueueJob({ kind: DECISION_JOB, dedupeKey: `${DECISION_JOB}:${row.id}`, payload: { request_id: row.id } });

  return {
    async create(input: CreateRequest): Promise<NeedsYouRequest> {
      if (deps.display) input = await deps.display(input);
      if (input.subject === 'tool_write' && input.runId) {
        const merged = await transaction(async (db) => {
          await db.select({ id: runs.id }).from(runs).where(eq(runs.id, input.runId!)).for('update');
          const [existing] = await db
            .select()
            .from(requests)
            .where(
              and(eq(requests.runId, input.runId!), eq(requests.subject, 'tool_write'), eq(requests.status, 'pending')),
            )
            .for('update');
          if (!existing) return null;
          const calls = (existing.payload.calls as Record<string, unknown>[] | undefined) ?? [
            { step_id: existing.stepId, ...existing.payload },
          ];
          calls.push({ step_id: input.stepId, ...input.payload });
          const scope = existing.payload.standing_scope as { type: string; id: string; actions: string[] } | undefined;
          const added = input.payload.standing_scope as typeof scope;
          const sameScope = scope && added && scope.type === added.type && scope.id === added.id;
          const payload = {
            ...existing.payload,
            calls,
            tier: existing.payload.tier === 'tier3' || input.payload.tier === 'tier3' ? 'tier3' : 'tier2',
            standing_scope: sameScope
              ? { ...scope, actions: [...new Set([...scope.actions, ...added.actions])] }
              : null,
            details: calls.flatMap((call, index) => [
              { label: String(index + 1), value: String(call.summary ?? input.title) },
              ...((call.details as unknown[]) ?? []),
            ]),
            batch_ready: false,
          };
          const [row] = await db
            .update(requests)
            .set({ payload, updatedAt: sql`now()` })
            .where(eq(requests.id, existing.id))
            .returning();
          return row!;
        });
        if (merged) {
          announce(merged);
          return merged;
        }
      }
      const [row] = await getDb()
        .insert(requests)
        .values({
          id: newId('request'),
          memberId: input.memberId,
          kind: input.kind,
          subject: input.subject,
          payload: {
            ...input.payload,
            title: input.title,
            ...(input.subject === 'tool_write' ? { batch_ready: false } : {}),
          },
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
        payload: { kind: input.kind },
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

    /**
     * The one way a request is decided: from pending, before it expires, exactly once. The
     * decision and the job that carries it out commit together.
     */
    async settle(
      memberId: string,
      id: string,
      outcome: { status: Exclude<RequestStatus, 'pending' | 'expired'>; result: Record<string, unknown> },
    ): Promise<NeedsYouRequest> {
      const row = await transaction(async (db) => {
        const [current] = await db
          .select()
          .from(requests)
          .where(and(eq(requests.id, id), eq(requests.memberId, memberId)))
          .for('update');
        if (current?.payload.batch_ready === false)
          throw conflict('request_building', 'The Agent is still preparing this approval card.');
        const [settled] = await db
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
        if (!settled) return null;
        await countActive(memberId);
        if (outcome.status === 'approved' && outcome.result.standing === true) {
          if (!deps.approvals) throw conflict('standing_not_allowed', 'Standing approvals are unavailable.');
          await deps.approvals.grant(settled);
        }
        await deps.notifications.markRequestRead(id);
        await queueDecision(settled);
        return settled;
      });
      if (!row) {
        const current = await this.get(memberId, id);
        if (current.status === 'pending') throw conflict('request_expired', 'This card has expired.');
        throw conflict('request_settled', 'This card was already decided.');
      }
      announce(row);
      deps.decided();
      return row;
    },

    async ready(runId: string) {
      const rows = await getDb()
        .update(requests)
        .set({ payload: sql`${requests.payload} || '{"batch_ready":true}'::jsonb` })
        .where(and(eq(requests.runId, runId), eq(requests.status, 'pending'), eq(requests.subject, 'tool_write')))
        .returning();
      for (const row of rows) announce(row);
    },

    /** Pending requests past their time become expired; the engine's worker follows each up. */
    async expireDue(): Promise<NeedsYouRequest[]> {
      const rows = await transaction(async (db) => {
        const expired = await db
          .update(requests)
          .set({ status: 'expired', updatedAt: sql`now()`, version: sql`${requests.version} + 1` })
          .where(and(eq(requests.status, 'pending'), lt(requests.expiresAt, new Date().toISOString())))
          .returning();
        for (const row of expired) {
          await deps.notifications.markRequestRead(row.id);
          await queueDecision(row);
        }
        return expired;
      });
      for (const row of rows) announce(row);
      if (rows.length) deps.decided();
      return rows;
    },

    /**
     * Pending cards that can no longer be decided expire now: the reply that raised them was
     * removed (runIds), or their member left the conversation. Joins the open transaction; the
     * caller announces the returned rows once it commits.
     */
    async expireOpen(where: { runIds: string[] } | { memberId: string; conversationId: string }) {
      if ('runIds' in where && !where.runIds.length) return [];
      const rows = await getDb()
        .update(requests)
        .set({ status: 'expired', updatedAt: sql`now()`, version: sql`${requests.version} + 1` })
        .where(
          and(
            eq(requests.status, 'pending'),
            'runIds' in where
              ? inArray(requests.runId, where.runIds)
              : and(eq(requests.memberId, where.memberId), eq(requests.conversationId, where.conversationId)),
          ),
        )
        .returning();
      for (const row of rows) await deps.notifications.markRequestRead(row.id);
      return rows;
    },

    announce,
  };
}

export type RequestsService = ReturnType<typeof createRequestsService>;
