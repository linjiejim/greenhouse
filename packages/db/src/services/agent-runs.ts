/**
 * Cloud Agent run service — workspaces, runs, events, artifacts (PostgreSQL).
 *
 * Backing store for the cloud-agent controller state machine
 * (design: docs/specs/20260731-cloud-agent-runtime.md). The service is
 * deliberately thin: status-transition legality and queue admission are the
 * controller's job (apps/api/src/cloud-agent/); rows here are the durable
 * checkpoints its boot sweep resumes from.
 */

import { randomBytes } from 'node:crypto';
import { eq, and, gt, lte, lt, desc, asc, inArray, sql, notExists, isNotNull, isNull, or } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import {
  agentWorkspaces,
  agentRuns,
  agentRunEvents,
  agentArtifacts,
  agentRunApprovals,
  agentRunOutbox,
} from '../schema/index.js';
import type {
  AgentWorkspaceRow,
  AgentRunRow,
  AgentRunStatus,
  AgentRunEventRow,
  AgentArtifactRow,
  AgentRunApprovalRow,
  AgentRunOutboxRow,
} from '../schema/agent-run.js';

const ACTIVE_STATUSES = ['starting', 'running'] as const satisfies readonly AgentRunStatus[];

export interface AgentWorkspaceInput {
  user_id: string;
  name: string;
}

export interface AgentWorkspaceUpdate {
  name?: string;
  status?: AgentWorkspaceRow['status'];
  disk_bytes?: number;
  cos_archive_key?: string | null;
  last_used_at?: string;
}

export interface AgentRunInput {
  /** Optional caller-generated id for side effects that must be staged before the row is visible. */
  id?: string;
  user_id: string;
  workspace_id: number;
  title: string;
  prompt: string;
  original_prompt?: string;
  input_manifest?: string;
  dispatch_id?: string | null;
  model: string;
  fallback_model?: string | null;
  session_id?: string | null;
  max_wall_ms?: number;
  max_requests?: number;
}

export function createAgentRunId(): string {
  return `car_${randomBytes(8).toString('hex')}`;
}

export interface AgentRunUpdate {
  status?: AgentRunStatus;
  container_id?: string | null;
  relay_client_id?: string | null;
  used_requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  result_summary?: string | null;
  failure_code?: string | null;
  error?: string | null;
  journal_storage_key?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  settled_at?: string | null;
}

export interface AgentRunEventInput {
  seq: number;
  type: string;
  payload: string;
}

export interface AgentArtifactInput {
  run_id: string;
  path: string;
  size_bytes: number;
  content_type: string;
  sha256: string;
  storage_key: string;
}

export interface AgentRunListOpts {
  limit?: number;
  offset?: number;
}

export interface AgentRunReconciliationCursor {
  created_at: string;
  id: string;
}

export interface AgentRunReconciliationPage {
  items: AgentRunRow[];
  next_cursor: AgentRunReconciliationCursor | null;
}

export type AgentRunRequestAdmissionResult =
  | { ok: true; run: AgentRunRow }
  | { ok: false; reason: 'not_active' | 'request_limit_exhausted' };

export interface AgentRunApprovalInput {
  run_id: string;
  user_id: string;
  tool_id: string;
  action?: string | null;
  input_hash: string;
  input_json: string;
  ttl_ms: number;
}

export interface AgentRunOutboxInput {
  run_id: string;
  session_id: string;
  message_id: string;
  content: string;
}

export function createAgentRunService(db: Db) {
  const service = {
    // ─── Workspaces ──────────────────────────────────────

    async createWorkspace(input: AgentWorkspaceInput): Promise<AgentWorkspaceRow> {
      const now = nowIso();
      const rows = await db
        .insert(agentWorkspaces)
        .values({ user_id: input.user_id, name: input.name, last_used_at: now, created_at: now, updated_at: now })
        .returning();
      return rows[0]!;
    },

    async getWorkspaceById(id: number): Promise<AgentWorkspaceRow | undefined> {
      const rows = await db.select().from(agentWorkspaces).where(eq(agentWorkspaces.id, id));
      return rows[0];
    },

    async updateWorkspace(id: number, patch: AgentWorkspaceUpdate): Promise<AgentWorkspaceRow | undefined> {
      const rows = await db
        .update(agentWorkspaces)
        .set({ ...patch, updated_at: nowIso() })
        .where(eq(agentWorkspaces.id, id))
        .returning();
      return rows[0];
    },

    async sumWorkspaceDiskByUser(userId: string): Promise<number> {
      const rows = await db
        .select({ bytes: sql<number>`COALESCE(SUM(${agentWorkspaces.disk_bytes}), 0)` })
        .from(agentWorkspaces)
        .where(eq(agentWorkspaces.user_id, userId));
      return Number(rows[0]?.bytes ?? 0);
    },

    /** Active, stale workspaces with no starting/running run. */
    async listArchivableWorkspaces(cutoff: string, limit = 50): Promise<AgentWorkspaceRow[]> {
      return db
        .select()
        .from(agentWorkspaces)
        .where(
          and(
            eq(agentWorkspaces.status, 'active'),
            lt(agentWorkspaces.last_used_at, cutoff),
            notExists(
              db
                .select({ one: sql<number>`1` })
                .from(agentRuns)
                .where(
                  and(eq(agentRuns.workspace_id, agentWorkspaces.id), inArray(agentRuns.status, [...ACTIVE_STATUSES])),
                ),
            ),
          ),
        )
        .orderBy(asc(agentWorkspaces.last_used_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    // ─── Runs ────────────────────────────────────────────

    async createRun(input: AgentRunInput): Promise<AgentRunRow> {
      const now = nowIso();
      const rows = await db
        .insert(agentRuns)
        .values({
          id: input.id ?? createAgentRunId(),
          user_id: input.user_id,
          workspace_id: input.workspace_id,
          dispatch_id: input.dispatch_id ?? null,
          title: input.title,
          original_prompt: input.original_prompt ?? input.prompt,
          prompt: input.prompt,
          input_manifest: input.input_manifest ?? '[]',
          model: input.model,
          fallback_model: input.fallback_model ?? null,
          session_id: input.session_id ?? null,
          ...(input.max_wall_ms !== undefined ? { max_wall_ms: input.max_wall_ms } : {}),
          ...(input.max_requests !== undefined ? { max_requests: input.max_requests } : {}),
          queued_at: now,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return rows[0]!;
    },

    async getRunById(id: string): Promise<AgentRunRow | undefined> {
      const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
      return rows[0];
    },

    async getRunByDispatchId(dispatchId: string): Promise<AgentRunRow | undefined> {
      const rows = await db.select().from(agentRuns).where(eq(agentRuns.dispatch_id, dispatchId)).limit(1);
      return rows[0];
    },

    /**
     * Server-authoritative per-Run request admission for Mission relay calls.
     * The sandbox counter is telemetry only: every request that can cross the
     * provider boundary must atomically consume one slot here first.
     */
    async reserveRequest(id: string, userId: string): Promise<AgentRunRequestAdmissionResult> {
      const rows = await db
        .update(agentRuns)
        .set({ used_requests: sql`${agentRuns.used_requests} + 1`, updated_at: nowIso() })
        .where(
          and(
            eq(agentRuns.id, id),
            eq(agentRuns.user_id, userId),
            inArray(agentRuns.status, [...ACTIVE_STATUSES]),
            sql`${agentRuns.used_requests} < ${agentRuns.max_requests}`,
          ),
        )
        .returning();
      if (rows[0]) return { ok: true, run: rows[0] };
      const current = await service.getRunById(id);
      if (
        current &&
        current.user_id === userId &&
        ACTIVE_STATUSES.includes(current.status as (typeof ACTIVE_STATUSES)[number]) &&
        current.used_requests >= current.max_requests
      ) {
        return { ok: false, reason: 'request_limit_exhausted' };
      }
      return { ok: false, reason: 'not_active' };
    },

    async updateRun(id: string, patch: AgentRunUpdate): Promise<AgentRunRow | undefined> {
      const rows = await db
        .update(agentRuns)
        .set({ ...patch, updated_at: nowIso() })
        .where(eq(agentRuns.id, id))
        .returning();
      return rows[0];
    },

    /**
     * Transition a run out of a set of expected statuses (compare-and-set).
     * Returns undefined when the run was not in `from` — the caller lost the
     * race (e.g. cancel vs completion) and must not apply side effects.
     */
    async transitionRun(
      id: string,
      from: readonly AgentRunStatus[],
      patch: AgentRunUpdate & { status: AgentRunStatus },
    ): Promise<AgentRunRow | undefined> {
      const rows = await db
        .update(agentRuns)
        .set({ ...patch, updated_at: nowIso() })
        .where(and(eq(agentRuns.id, id), inArray(agentRuns.status, [...from])))
        .returning();
      return rows[0];
    },

    async listRunsByUser(userId: string, opts: AgentRunListOpts = {}): Promise<AgentRunRow[]> {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      return db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.user_id, userId))
        .orderBy(desc(agentRuns.created_at))
        .limit(limit)
        .offset(Math.max(opts.offset ?? 0, 0));
    },

    async countRunsByUser(userId: string): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(agentRuns)
        .where(eq(agentRuns.user_id, userId));
      return Number(rows[0]?.count ?? 0);
    },

    /**
     * Stable all-owner scan for rebuilding the Runtime read model. This is not
     * a user-facing list: the API adapter owns authorization after projection.
     */
    async listRunsForRuntimeReconciliation(
      input: {
        cursor?: AgentRunReconciliationCursor;
        limit?: number;
      } = {},
    ): Promise<AgentRunReconciliationPage> {
      const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
      const rows = await db
        .select()
        .from(agentRuns)
        .where(
          input.cursor
            ? or(
                gt(agentRuns.created_at, input.cursor.created_at),
                and(eq(agentRuns.created_at, input.cursor.created_at), gt(agentRuns.id, input.cursor.id)),
              )
            : undefined,
        )
        .orderBy(asc(agentRuns.created_at), asc(agentRuns.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const tail = items.at(-1);
      return {
        items,
        next_cursor: hasMore && tail ? { created_at: tail.created_at, id: tail.id } : null,
      };
    },

    /** Runs the controller must own a container for (boot-sweep scope). */
    async listActiveRuns(): Promise<AgentRunRow[]> {
      return db
        .select()
        .from(agentRuns)
        .where(inArray(agentRuns.status, [...ACTIVE_STATUSES]));
    },

    /** Every run that an account-security suspension must settle immediately. */
    async listNonTerminalRunsByUser(userId: string): Promise<AgentRunRow[]> {
      return db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.user_id, userId), inArray(agentRuns.status, ['queued', ...ACTIVE_STATUSES])))
        .orderBy(asc(agentRuns.queued_at));
    },

    /** Terminal CAS won, but cleanup/journal/outcome reconciliation did not finish. */
    async listUnsettledTerminalRuns(limit = 50): Promise<AgentRunRow[]> {
      return db
        .select()
        .from(agentRuns)
        .where(and(inArray(agentRuns.status, ['completed', 'failed', 'canceled']), isNull(agentRuns.settled_at)))
        .orderBy(asc(agentRuns.ended_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    async countActiveRuns(): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(agentRuns)
        .where(inArray(agentRuns.status, [...ACTIVE_STATUSES]));
      return Number(rows[0]?.count ?? 0);
    },

    async countActiveRunsByUser(userId: string): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(agentRuns)
        .where(and(eq(agentRuns.user_id, userId), inArray(agentRuns.status, [...ACTIVE_STATUSES])));
      return Number(rows[0]?.count ?? 0);
    },

    /** All runs conversing through one mission session, oldest first. */
    async listRunsBySession(sessionId: string): Promise<AgentRunRow[]> {
      return db.select().from(agentRuns).where(eq(agentRuns.session_id, sessionId)).orderBy(asc(agentRuns.created_at));
    },

    /** All runs in one workspace, oldest first (follow-up lineage). */
    async listRunsByWorkspace(workspaceId: number): Promise<AgentRunRow[]> {
      return db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.workspace_id, workspaceId))
        .orderBy(asc(agentRuns.created_at));
    },

    /**
     * All queued runs, oldest first (admission is the controller's decision).
     *
     * Do not cap this scan: a user may have many queued follow-ups behind their
     * one active run. A fixed first-page limit lets that user's blocked rows
     * hide another user's runnable row and leaves global capacity idle.
     */
    async listQueuedRuns(): Promise<AgentRunRow[]> {
      return db.select().from(agentRuns).where(eq(agentRuns.status, 'queued')).orderBy(asc(agentRuns.queued_at));
    },

    /**
     * Atomically claim one globally admissible run across every API instance.
     * The advisory lock covers only the short DB decision; Docker I/O starts
     * after commit so another user can be admitted immediately afterwards.
     */
    async claimNextQueuedRun(maxConcurrent: number): Promise<AgentRunRow | undefined> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('greenhouse-cloud-agent-admission'))`);

        const [activeCount] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(agentRuns)
          .where(inArray(agentRuns.status, [...ACTIVE_STATUSES]));
        if (Number(activeCount?.count ?? 0) >= maxConcurrent) return undefined;

        const queued = await tx
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.status, 'queued'))
          .orderBy(asc(agentRuns.queued_at));
        if (queued.length === 0) return undefined;

        const activeUsers = await tx
          .select({ user_id: agentRuns.user_id })
          .from(agentRuns)
          .where(inArray(agentRuns.status, [...ACTIVE_STATUSES]));
        const blocked = new Set(activeUsers.map((row) => row.user_id));
        const candidate = queued.find((run) => !blocked.has(run.user_id));
        if (!candidate) return undefined;

        const now = nowIso();
        const [claimed] = await tx
          .update(agentRuns)
          .set({ status: 'starting', started_at: now, updated_at: now })
          .where(and(eq(agentRuns.id, candidate.id), eq(agentRuns.status, 'queued')))
          .returning();
        return claimed;
      });
    },

    // ─── Mutation approval leases ───────────────────────

    async requestApproval(input: AgentRunApprovalInput): Promise<AgentRunApprovalRow> {
      const now = nowIso();
      await db
        .update(agentRunApprovals)
        .set({ status: 'expired', updated_at: now })
        .where(
          and(
            eq(agentRunApprovals.run_id, input.run_id),
            eq(agentRunApprovals.status, 'pending'),
            lte(agentRunApprovals.expires_at, now),
          ),
        );

      const [existing] = await db
        .select()
        .from(agentRunApprovals)
        .where(
          and(
            eq(agentRunApprovals.run_id, input.run_id),
            eq(agentRunApprovals.tool_id, input.tool_id),
            eq(agentRunApprovals.input_hash, input.input_hash),
            eq(agentRunApprovals.status, 'pending'),
            gt(agentRunApprovals.expires_at, now),
          ),
        )
        .orderBy(desc(agentRunApprovals.created_at))
        .limit(1);
      if (existing) return existing;

      const expiresAt = new Date(Date.now() + Math.max(input.ttl_ms, 1_000)).toISOString();
      const [created] = await db
        .insert(agentRunApprovals)
        .values({
          id: `caa_${randomBytes(8).toString('hex')}`,
          run_id: input.run_id,
          user_id: input.user_id,
          tool_id: input.tool_id,
          action: input.action ?? null,
          input_hash: input.input_hash,
          input_json: input.input_json,
          status: 'pending',
          expires_at: expiresAt,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return created!;
    },

    async getApprovalById(id: string): Promise<AgentRunApprovalRow | undefined> {
      const [row] = await db.select().from(agentRunApprovals).where(eq(agentRunApprovals.id, id)).limit(1);
      if (!row) return undefined;
      if ((row.status === 'pending' || row.status === 'approved') && Date.parse(row.expires_at) <= Date.now()) {
        const [expired] = await db
          .update(agentRunApprovals)
          .set({ status: 'expired', updated_at: nowIso() })
          .where(and(eq(agentRunApprovals.id, id), inArray(agentRunApprovals.status, ['pending', 'approved'])))
          .returning();
        return expired ?? row;
      }
      return row;
    },

    async listApprovals(runId: string, limit = 50): Promise<AgentRunApprovalRow[]> {
      return db
        .select()
        .from(agentRunApprovals)
        .where(eq(agentRunApprovals.run_id, runId))
        .orderBy(desc(agentRunApprovals.created_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    async countPendingApprovalsByRun(runIds: string[]): Promise<Record<string, number>> {
      if (runIds.length === 0) return {};
      const rows = await db
        .select({ run_id: agentRunApprovals.run_id, count: sql<number>`count(*)` })
        .from(agentRunApprovals)
        .where(
          and(
            inArray(agentRunApprovals.run_id, runIds),
            eq(agentRunApprovals.status, 'pending'),
            gt(agentRunApprovals.expires_at, nowIso()),
          ),
        )
        .groupBy(agentRunApprovals.run_id);
      return Object.fromEntries(rows.map((row) => [row.run_id, Number(row.count)]));
    },

    async decideApproval(
      id: string,
      runId: string,
      ownerUserId: string,
      decision: 'approve' | 'deny',
      decidedBy: string,
    ): Promise<AgentRunApprovalRow | undefined> {
      const now = nowIso();
      const [row] = await db
        .update(agentRunApprovals)
        .set({
          status: decision === 'approve' ? 'approved' : 'denied',
          decided_by: decidedBy,
          decided_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(agentRunApprovals.id, id),
            eq(agentRunApprovals.run_id, runId),
            eq(agentRunApprovals.user_id, ownerUserId),
            eq(agentRunApprovals.status, 'pending'),
            gt(agentRunApprovals.expires_at, now),
          ),
        )
        .returning();
      return row;
    },

    async consumeApproval(input: {
      id: string;
      run_id: string;
      user_id: string;
      tool_id: string;
      input_hash: string;
    }): Promise<AgentRunApprovalRow | undefined> {
      const now = nowIso();
      const [row] = await db
        .update(agentRunApprovals)
        .set({ status: 'consumed', consumed_at: now, updated_at: now })
        .where(
          and(
            eq(agentRunApprovals.id, input.id),
            eq(agentRunApprovals.run_id, input.run_id),
            eq(agentRunApprovals.user_id, input.user_id),
            eq(agentRunApprovals.tool_id, input.tool_id),
            eq(agentRunApprovals.input_hash, input.input_hash),
            eq(agentRunApprovals.status, 'approved'),
            gt(agentRunApprovals.expires_at, now),
          ),
        )
        .returning();
      return row;
    },

    // ─── Durable outcome outbox ─────────────────────────

    async enqueueOutcome(input: AgentRunOutboxInput): Promise<AgentRunOutboxRow> {
      const now = nowIso();
      const rows = await db
        .insert(agentRunOutbox)
        .values({ ...input, status: 'pending', created_at: now, updated_at: now })
        .onConflictDoNothing({ target: agentRunOutbox.run_id })
        .returning();
      if (rows[0]) return rows[0];
      const [existing] = await db.select().from(agentRunOutbox).where(eq(agentRunOutbox.run_id, input.run_id));
      return existing!;
    },

    async listPendingOutcomes(limit = 50): Promise<AgentRunOutboxRow[]> {
      return db
        .select()
        .from(agentRunOutbox)
        .where(eq(agentRunOutbox.status, 'pending'))
        .orderBy(asc(agentRunOutbox.created_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    /** Terminal session-bound runs whose outbox insert was interrupted. */
    async listRunsMissingOutcome(limit = 50): Promise<AgentRunRow[]> {
      return db
        .select()
        .from(agentRuns)
        .where(
          and(
            inArray(agentRuns.status, ['completed', 'failed', 'canceled']),
            isNotNull(agentRuns.session_id),
            notExists(
              db
                .select({ one: sql<number>`1` })
                .from(agentRunOutbox)
                .where(eq(agentRunOutbox.run_id, agentRuns.id)),
            ),
          ),
        )
        .orderBy(asc(agentRuns.ended_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    async markOutcomeDelivered(runId: string): Promise<void> {
      const now = nowIso();
      await db
        .update(agentRunOutbox)
        .set({ status: 'delivered', delivered_at: now, last_error: null, updated_at: now })
        .where(eq(agentRunOutbox.run_id, runId));
    },

    async markOutcomeFailed(runId: string, error: string): Promise<void> {
      await db
        .update(agentRunOutbox)
        .set({ attempts: sql`${agentRunOutbox.attempts} + 1`, last_error: error, updated_at: nowIso() })
        .where(and(eq(agentRunOutbox.run_id, runId), eq(agentRunOutbox.status, 'pending')));
    },

    // ─── Events ──────────────────────────────────────────

    /**
     * Idempotent batch append: the runner retries pushes after api restarts,
     * so duplicate (run_id, seq) rows are silently skipped. Returns the
     * number of rows actually inserted.
     */
    async appendEvents(runId: string, events: AgentRunEventInput[]): Promise<number> {
      if (events.length === 0) return 0;
      const now = nowIso();
      const rows = await db
        .insert(agentRunEvents)
        .values(events.map((e) => ({ run_id: runId, seq: e.seq, type: e.type, payload: e.payload, created_at: now })))
        .onConflictDoNothing({ target: [agentRunEvents.run_id, agentRunEvents.seq] })
        .returning({ id: agentRunEvents.id });
      return rows.length;
    },

    /** Incremental replay: events with seq > after, ascending. */
    async listEvents(runId: string, opts: { after?: number; limit?: number } = {}): Promise<AgentRunEventRow[]> {
      const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
      const after = opts.after ?? 0;
      return db
        .select()
        .from(agentRunEvents)
        .where(and(eq(agentRunEvents.run_id, runId), gt(agentRunEvents.seq, after)))
        .orderBy(asc(agentRunEvents.seq))
        .limit(limit);
    },

    // ─── Artifacts ───────────────────────────────────────

    async createArtifact(input: AgentArtifactInput): Promise<AgentArtifactRow> {
      const rows = await db
        .insert(agentArtifacts)
        .values({ ...input, created_at: nowIso() })
        .returning();
      return rows[0]!;
    },

    async listArtifacts(runId: string): Promise<AgentArtifactRow[]> {
      return db.select().from(agentArtifacts).where(eq(agentArtifacts.run_id, runId)).orderBy(asc(agentArtifacts.id));
    },

    /**
     * Every deliverable ever accepted from any run in this workspace, as
     * (path, sha256) pairs.
     *
     * The terminal sweep uses this to decide what "new" means. Content
     * addressing rather than mtime is the whole point: workspaces are
     * persistent and shared across follow-up runs, and timestamps survive
     * mv/unzip/cp -p, so "modified after this run started" both misses real
     * deliverables and re-offers old ones. A file whose exact bytes were never
     * delivered at this path is new, whatever its clock says.
     */
    async listArtifactDigestsForWorkspace(workspaceId: number): Promise<Array<{ path: string; sha256: string }>> {
      return db
        .select({ path: agentArtifacts.path, sha256: agentArtifacts.sha256 })
        .from(agentArtifacts)
        .innerJoin(agentRuns, eq(agentArtifacts.run_id, agentRuns.id))
        .where(eq(agentRuns.workspace_id, workspaceId));
    },

    async getArtifactById(id: number): Promise<AgentArtifactRow | undefined> {
      const rows = await db.select().from(agentArtifacts).where(eq(agentArtifacts.id, id));
      return rows[0];
    },
  };
  return service;
}

export type AgentRunService = ReturnType<typeof createAgentRunService>;
