/**
 * The Runs page: background runs a member owns, with their steps and timeline. Replies
 * (kind `turn`) are runs too but never listed here. Cancel and retry go through the engine.
 */

import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Page, RunDetail, RunView } from '@greenhouse/contract';
import { getDb, runEvents, runs, runSteps, type Run, type RunSource } from '@greenhouse/db';
import type { Background } from '../../engine/background.js';
import { conflict, notFound } from '../../http/errors.js';
import { decodeCursor, toPage } from '../../http/pagination.js';

const ACTIVE = ['queued', 'running', 'waiting'] as const;
const DONE = ['succeeded', 'failed', 'canceled'] as const;
const MAX_DETAIL_ROWS = 200;

const toRun = (row: Run): RunView => ({
  id: row.id,
  agent_id: row.agentId,
  title: row.title,
  status: row.status,
  source: row.source,
  source_id: row.sourceId,
  conversation_id: row.conversationId,
  attempt: row.attempt,
  error: row.errorCode ? { code: row.errorCode, message: row.errorMessage ?? '' } : null,
  started_at: row.startedAt,
  finished_at: row.finishedAt,
  created_at: row.createdAt,
});

export function createRunsService(deps: { background: () => Background }) {
  async function own(memberId: string, runId: string): Promise<Run> {
    const [row] = await getDb()
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.ownerId, memberId), eq(runs.kind, 'background')));
    if (!row) throw notFound('Run');
    return row;
  }

  return {
    async list(
      memberId: string,
      query: { state: 'active' | 'done' | 'all'; agent?: string; source?: RunSource; cursor?: string; limit: number },
    ): Promise<Page<RunView>> {
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.ownerId, memberId),
            eq(runs.kind, 'background'),
            query.state === 'active' ? inArray(runs.status, [...ACTIVE]) : undefined,
            query.state === 'done' ? inArray(runs.status, [...DONE]) : undefined,
            query.agent ? eq(runs.agentId, query.agent) : undefined,
            query.source ? eq(runs.source, query.source) : undefined,
            before ? lt(runs.id, before) : undefined,
          ),
        )
        .orderBy(desc(runs.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, toRun);
    },

    async get(memberId: string, runId: string): Promise<RunDetail> {
      const row = await own(memberId, runId);
      const db = getDb();
      const [steps, events] = await Promise.all([
        db
          .select()
          .from(runSteps)
          .where(eq(runSteps.runId, runId))
          .orderBy(asc(runSteps.createdAt))
          .limit(MAX_DETAIL_ROWS),
        db
          .select()
          .from(runEvents)
          .where(eq(runEvents.runId, runId))
          .orderBy(asc(runEvents.seq))
          .limit(MAX_DETAIL_ROWS),
      ]);
      const output = row.output && typeof row.output.text === 'string' ? row.output.text : null;
      return {
        ...toRun(row),
        brief: row.brief,
        output,
        steps: steps.map((step) => ({
          id: step.id,
          tool: step.toolName,
          kind: step.kind,
          status: step.status,
          attempt: step.attempt,
          input: step.input,
          output: step.output,
          error: step.error,
          duration_ms: step.durationMs,
          request_id: step.requestId,
          started_at: step.startedAt,
        })),
        events: events.map((event) => ({
          seq: event.seq,
          type: event.type,
          payload: event.payload,
          actor: event.actor,
          created_at: event.createdAt,
        })),
      };
    },

    async cancel(memberId: string, runId: string): Promise<RunDetail> {
      const row = await own(memberId, runId);
      if (!(ACTIVE as readonly string[]).includes(row.status))
        throw conflict('run_finished', 'This run has already ended.');
      await deps.background().cancel(runId, memberId);
      return this.get(memberId, runId);
    },

    /** Runs it again; steps that already succeeded are reused. */
    async retry(memberId: string, runId: string): Promise<RunDetail> {
      const row = await own(memberId, runId);
      if (row.status !== 'failed' && row.status !== 'canceled') {
        throw conflict('run_not_retryable', 'Only a failed or stopped run can be run again.');
      }
      await deps.background().retry(runId, memberId);
      return this.get(memberId, runId);
    },
  };
}

export type RunsService = ReturnType<typeof createRunsService>;
