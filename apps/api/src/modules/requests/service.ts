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
  conversations,
  getDb,
  newId,
  requests,
  runs,
  transaction,
  type NeedsYouRequest,
  type RequestKind,
  type RequestStatus,
} from '@greenhouse/db';
import { approvalScopeSchema } from '@greenhouse/contract';
import { resolveRequestTargetKey } from './target.js';
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
  const announce = (row: NeedsYouRequest) => {
    if (row.status !== 'pending') deps.notifications.announceRemoved(row.memberId, row.id);
    deps.hub.publish([row.memberId], {
      type: 'request.updated',
      data: { request_id: row.id, status: row.status, conversation_id: row.conversationId },
    });
  };

  /** Joins the open transaction: the job commits with the decision. */
  const queueDecision = (row: NeedsYouRequest) =>
    enqueueJob({ kind: DECISION_JOB, dedupeKey: `${DECISION_JOB}:${row.id}`, payload: { request_id: row.id } });

  const lockConversation = async (id: string | null | undefined) => {
    if (id)
      await getDb().select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id)).for('update');
  };

  /** All automatic retirements share the decision queue and notification cleanup. */
  const retire = async (
    rows: NeedsYouRequest[],
    status: 'superseded' | 'withdrawn',
    result: Record<string, unknown>,
  ) => {
    const retired: NeedsYouRequest[] = [];
    for (const candidate of rows) {
      const [row] = await getDb()
        .update(requests)
        .set({
          status,
          result,
          decidedAt: sql`now()`,
          updatedAt: sql`now()`,
          version: sql`${requests.version} + 1`,
        })
        .where(and(eq(requests.id, candidate.id), eq(requests.status, 'pending')))
        .returning();
      if (!row) continue;
      await deps.notifications.clearRequest(row.id);
      await queueDecision(row);
      retired.push(row);
    }
    return retired;
  };

  const replaceOlder = async (row: NeedsYouRequest) => {
    if (!row.conversationId || !row.agentId || !row.targetKey) return [];
    const older = await getDb()
      .select()
      .from(requests)
      .where(
        and(
          eq(requests.memberId, row.memberId),
          eq(requests.conversationId, row.conversationId),
          eq(requests.agentId, row.agentId),
          eq(requests.subject, row.subject),
          eq(requests.targetKey, row.targetKey),
          eq(requests.status, 'pending'),
          lt(requests.id, row.id),
        ),
      )
      .orderBy(requests.id)
      .for('update');
    return retire(older, 'superseded', { reason: 'replaced', replacement_request_id: row.id });
  };

  const announceAll = (rows: NeedsYouRequest[]) => {
    for (const row of rows) announce(row);
  };

  return {
    async create(input: CreateRequest): Promise<NeedsYouRequest> {
      if (deps.display) input = await deps.display(input);
      const changed: NeedsYouRequest[] = [];
      const created = await transaction(async () => {
        await lockConversation(input.conversationId);
        if (input.runId) {
          const [run] = await getDb().select().from(runs).where(eq(runs.id, input.runId)).for('update');
          if (run?.desiredState === 'cancel') throw conflict('run_canceled', 'This run was canceled.');
        }
        if (input.subject === 'tool_write' && input.runId) {
          const merged = await transaction(async (db) => {
            await db.select({ id: runs.id }).from(runs).where(eq(runs.id, input.runId!)).for('update');
            const [existing] = await db
              .select()
              .from(requests)
              .where(
                and(
                  eq(requests.runId, input.runId!),
                  eq(requests.subject, 'tool_write'),
                  eq(requests.status, 'pending'),
                  sql`${requests.payload}->>'batch_ready' = 'false'`,
                ),
              )
              .for('update');
            if (!existing) return null;
            const calls = (existing.payload.calls as Record<string, unknown>[] | undefined) ?? [
              { step_id: existing.stepId, ...existing.payload },
            ];
            calls.push({ step_id: input.stepId, ...input.payload });
            const scope = existing.payload.standing_scope as
              | { type: string; id: string; actions: string[] }
              | undefined;
            const added = input.payload.standing_scope as typeof scope;
            const sameScope = scope && added && scope.type === added.type && scope.id === added.id;
            const payload = {
              ...existing.payload,
              calls,
              ...(calls.some((call) => call.danger === true) ? { danger: true } : {}),
              tainted: existing.payload.tainted === true || input.payload.tainted === true,
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
            const targetKey = await resolveRequestTargetKey(
              merged.subject,
              merged.payload,
              merged.memberId,
              merged.agentId,
              merged.runId,
            );
            await getDb().update(requests).set({ targetKey }).where(eq(requests.id, merged.id));
            changed.push(...(await replaceOlder({ ...merged, targetKey })));
            changed.push(merged);
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
            targetKey: await resolveRequestTargetKey(
              input.subject,
              input.payload,
              input.memberId,
              input.agentId,
              input.runId,
            ),
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
        changed.push(...(await replaceOlder(row!)));
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
        changed.push(row!);
        return row!;
      });
      announceAll(changed);
      return created;
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
      const settledRows: NeedsYouRequest[] = [];
      const row = await transaction(async (db) => {
        const initial = await this.get(memberId, id);
        await lockConversation(initial.conversationId);
        const [current] = await db
          .select()
          .from(requests)
          .where(and(eq(requests.id, id), eq(requests.memberId, memberId)))
          .for('update');
        if (current?.status !== 'pending') throw conflict('request_settled', 'This card was already decided.');
        if (current.payload.batch_ready === false)
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
        await deps.notifications.clearRequest(id);
        await queueDecision(settled);
        settledRows.push(settled);
        // A tier2 decision covers only its declared actions, for this member and Agent here.
        const scope = approvalScopeSchema.safeParse(settled.payload.standing_scope);
        if (
          outcome.status === 'approved' &&
          settled.payload.tier === 'tier2' &&
          scope.success &&
          settled.conversationId &&
          settled.agentId
        ) {
          const others = await db
            .select()
            .from(requests)
            .where(
              and(
                eq(requests.memberId, memberId),
                eq(requests.agentId, settled.agentId),
                eq(requests.conversationId, settled.conversationId),
                eq(requests.subject, 'tool_write'),
                eq(requests.status, 'pending'),
                or(isNull(requests.expiresAt), gt(requests.expiresAt, new Date().toISOString())),
              ),
            )
            .orderBy(requests.id)
            .for('update');
          for (const candidate of others) {
            const otherScope = approvalScopeSchema.safeParse(candidate.payload.standing_scope);
            if (
              candidate.payload.tier !== 'tier2' ||
              candidate.payload.tainted === true ||
              candidate.payload.batch_ready === false ||
              !otherScope.success ||
              otherScope.data.type !== scope.data.type ||
              otherScope.data.id !== scope.data.id ||
              !otherScope.data.actions.every((action) => scope.data.actions.includes(action))
            )
              continue;
            const [run] = candidate.runId ? await db.select().from(runs).where(eq(runs.id, candidate.runId)) : [];
            // Tainted or canceled work never inherits consent from another card.
            if (
              !run ||
              run.desiredState !== 'run' ||
              run.checkpoint?.tainted === true ||
              run.input.event_woken === true ||
              run.input.reason === 'event' ||
              typeof run.input.helper_parent === 'string'
            )
              continue;
            const [covered] = await db
              .update(requests)
              .set({
                status: 'approved',
                result: { decision: 'approved', covered_by_request_id: settled.id },
                decidedBy: memberId,
                decidedAt: sql`now()`,
                updatedAt: sql`now()`,
                version: sql`${requests.version} + 1`,
              })
              .where(and(eq(requests.id, candidate.id), eq(requests.status, 'pending')))
              .returning();
            if (covered) {
              await deps.notifications.clearRequest(covered.id);
              await queueDecision(covered);
              settledRows.push(covered);
            }
          }
        }
        return settled;
      });
      if (!row) {
        const current = await this.get(memberId, id);
        if (current.status === 'pending') throw conflict('request_expired', 'This card has expired.');
        throw conflict('request_settled', 'This card was already decided.');
      }
      announceAll(settledRows);
      deps.decided();
      return row;
    },

    /** A room's plain answer can address its pending question without another mention. */
    async questionAgents(memberId: string, conversationId: string): Promise<string[]> {
      const rows = await getDb()
        .select({ agentId: requests.agentId })
        .from(requests)
        .where(
          and(
            eq(requests.memberId, memberId),
            eq(requests.conversationId, conversationId),
            eq(requests.subject, 'ask_user'),
            eq(requests.kind, 'question'),
            eq(requests.status, 'pending'),
            or(isNull(requests.expiresAt), gt(requests.expiresAt, new Date().toISOString())),
          ),
        );
      return [...new Set(rows.flatMap((row) => (row.agentId ? [row.agentId] : [])))];
    },

    /** A real member message answers questions only; it never decides an approval. */
    async answeredInChat(memberId: string, conversationId: string, agentIds: string[], messageId: string) {
      if (!agentIds.length) return;
      const rows = await transaction(async () => {
        await lockConversation(conversationId);
        const open = await getDb()
          .select()
          .from(requests)
          .where(
            and(
              eq(requests.memberId, memberId),
              eq(requests.conversationId, conversationId),
              inArray(requests.agentId, agentIds),
              eq(requests.subject, 'ask_user'),
              eq(requests.kind, 'question'),
              eq(requests.status, 'pending'),
              or(isNull(requests.expiresAt), gt(requests.expiresAt, new Date().toISOString())),
            ),
          )
          .orderBy(requests.id)
          .for('update');
        return retire(open, 'superseded', { reason: 'answered in chat', message_id: messageId });
      });
      announceAll(rows);
    },

    /** Cancellation withdraws the run's remaining cards, including non-blocking proposals. */
    async withdrawOpen(runIds: string[]) {
      if (!runIds.length) return [];
      const rows = await transaction(async () => {
        const open = await getDb()
          .select()
          .from(requests)
          .where(and(inArray(requests.runId, runIds), eq(requests.status, 'pending')))
          .orderBy(requests.id)
          .for('update');
        return retire(open, 'withdrawn', { reason: 'canceled' });
      });
      announceAll(rows);
      return rows;
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
          await deps.notifications.clearRequest(row.id);
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
      for (const row of rows) await deps.notifications.clearRequest(row.id);
      return rows;
    },

    announce,
  };
}

export type RequestsService = ReturnType<typeof createRequestsService>;
