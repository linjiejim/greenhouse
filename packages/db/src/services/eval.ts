/**
 * Eval service — eval dataset, run, and result persistence (PostgreSQL).
 */

import { createHash, randomUUID } from 'node:crypto';
import { eq, and, sql, like, or, desc, inArray, gte, lte } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type {
  EvalDataset,
  EvalRun,
  EvalResult,
  EvalResultWithQuestion,
  DatasetInput,
  RuntimeDatasetDraft,
  RuntimeDatasetTraceSource,
} from '@greenhouse/types/eval';

import type { Db } from '../client.js';
import { evalDatasets, evalRuns, evalResults } from '../schema/index.js';

export interface RunCreateOpts {
  name?: string;
  total: number;
  model?: string;
  profileId?: string;
  config?: Record<string, unknown>;
}

export interface QueuedRunCreateOpts extends RunCreateOpts {
  /** Exact immutable case selection captured when the request is accepted. */
  datasetIds: number[];
}

export interface QueuedRunCreateResult {
  run: EvalRun;
  results: EvalResult[];
}

export interface ResultCreateOpts {
  run_id: string;
  dataset_id: number;
  session_id?: string;
}

export interface ResultUpdateData {
  answer?: string;
  references_used?: Array<{ slug: string; title: string; category?: string }>;
  duration_ms?: number;
  ttfb_ms?: number;
  answer_length?: number;
  session_id?: string;
  score_accuracy?: number;
  score_completeness?: number;
  score_relevance?: number;
  score_speed?: number;
  score_final?: number;
  judge_reasoning?: Record<string, unknown>;
  status?: string;
  error?: string;
}

export interface RunComparison {
  runs: EvalRun[];
  results: Map<number, Record<string, EvalResultWithQuestion>>;
}

export interface DatasetFilters {
  category?: string;
  difficulty?: string;
  language?: string;
  enabled?: boolean;
  search?: string;
  sortBy?: 'id' | 'created_at' | 'updated_at';
  sortOrder?: 'asc' | 'desc';
  status?: string;
  source?: string;
  tags?: string[];
  created_by?: string;
  created_after?: string;
  created_before?: string;
  page?: number;
  page_size?: number;
}

export type DatasetBatchAction =
  | 'archive'
  | 'restore'
  | 'delete'
  | 'enable'
  | 'disable'
  | 'add_tags'
  | 'remove_tags'
  | 'deprecate';

export interface DatasetBatchOpts {
  action: DatasetBatchAction;
  ids: number[];
  tags?: string[];
  user_id?: string;
}

export interface RuntimeTraceDatasetCreateInput {
  source: RuntimeDatasetTraceSource;
  dataset: RuntimeDatasetDraft;
  actor_user_id: string;
  idempotency_key: string;
}

export interface RuntimeTraceDatasetCreateResult {
  dataset: EvalDataset;
  created: boolean;
}

export class EvalTraceIdempotencyConflictError extends Error {
  constructor() {
    super('Trace Dataset idempotency key was reused with different content');
    this.name = 'EvalTraceIdempotencyConflictError';
  }
}

const TRACE_PROVENANCE_PREFIX = '[runtime-trace:v1] ';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function traceProvenanceLine(notes: string | null): string | null {
  const firstLine = notes?.split('\n', 1)[0] ?? '';
  return firstLine.startsWith(TRACE_PROVENANCE_PREFIX) ? firstLine : null;
}

function notesWithPreservedTrace(existingNotes: string | null, requestedNotes: string): string {
  const provenance = traceProvenanceLine(existingNotes);
  if (!provenance) return requestedNotes;
  const operatorNotes = requestedNotes.startsWith(TRACE_PROVENANCE_PREFIX)
    ? requestedNotes.slice(
        requestedNotes.indexOf('\n\n') >= 0 ? requestedNotes.indexOf('\n\n') + 2 : requestedNotes.length,
      )
    : requestedNotes;
  return operatorNotes ? `${provenance}\n\n${operatorNotes}` : provenance;
}

function datasetValues(input: DatasetInput, now: string) {
  return {
    category: input.category,
    difficulty: input.difficulty ?? 'medium',
    question: input.question,
    ground_truth: input.ground_truth,
    expected_behavior: input.expected_behavior ?? null,
    tags: JSON.stringify(input.tags ?? []),
    language: input.language ?? 'en',
    is_negative: input.is_negative ? 1 : 0,
    enabled: input.enabled !== false ? 1 : 0,
    created_by: input.created_by ?? null,
    updated_by: input.created_by ?? null,
    source: input.source ?? 'manual',
    source_session_id: input.source_session_id ?? null,
    status: input.status ?? 'active',
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
  };
}

function storedGroundTruth(value: string): string {
  try {
    const facts = JSON.parse(value) as unknown;
    if (Array.isArray(facts) && facts.every((fact) => typeof fact === 'string')) return JSON.stringify(facts);
  } catch {
    // Trace capture's editor intentionally exposes one fact per plain-text
    // line; normalize it to the existing Eval runner's JSON-array contract.
  }
  return JSON.stringify(
    value
      .split(/\r?\n/u)
      .map((fact) => fact.trim())
      .filter(Boolean),
  );
}

export function createEvalService(db: Db) {
  const service = {
    // ─── Datasets ──────────────────────────────────────────

    async createDataset(input: DatasetInput): Promise<EvalDataset> {
      const now = nowIso();
      const [inserted] = await db.insert(evalDatasets).values(datasetValues(input, now)).returning();
      return inserted as EvalDataset;
    },

    /**
     * Explicit Trace → Dataset capture with transactional duplicate-click
     * protection. No preview path calls this method.
     */
    async createDatasetFromRuntimeTrace(
      input: RuntimeTraceDatasetCreateInput,
    ): Promise<RuntimeTraceDatasetCreateResult> {
      const captureId = sha256(`${input.source.runtime_run_id}\0${input.idempotency_key}`);
      const normalizedDataset = {
        category: input.dataset.category,
        difficulty: input.dataset.difficulty,
        question: input.dataset.question,
        ground_truth: input.dataset.ground_truth,
        expected_behavior: input.dataset.expected_behavior,
        tags: input.dataset.tags,
        language: input.dataset.language,
        is_negative: input.dataset.is_negative,
        enabled: input.dataset.enabled,
        notes: input.dataset.notes,
      };
      const contentSha256 = sha256(JSON.stringify(normalizedDataset));
      const provenance = {
        version: 1,
        capture_id: captureId,
        idempotency_key: input.idempotency_key,
        content_sha256: contentSha256,
        runtime_run_id: input.source.runtime_run_id,
        runtime_kind: input.source.runtime_kind,
        runtime_status: input.source.runtime_status,
        source_kind: input.source.source_kind,
        source_id: input.source.source_id,
        session_id: input.source.session_id,
      };
      const provenanceLine = `${TRACE_PROVENANCE_PREFIX}${JSON.stringify(provenance)}`;
      const notes = input.dataset.notes ? `${provenanceLine}\n\n${input.dataset.notes}` : provenanceLine;

      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`eval-trace:${captureId}`}, 0))`);
        const [existing] = await tx
          .select()
          .from(evalDatasets)
          .where(
            and(
              eq(evalDatasets.source, 'agent'),
              like(evalDatasets.notes, `${TRACE_PROVENANCE_PREFIX}%`),
              like(evalDatasets.notes, `%"capture_id":"${captureId}"%`),
            ),
          )
          .orderBy(evalDatasets.id)
          .limit(1);
        if (existing) {
          const firstLine = traceProvenanceLine(existing.notes) ?? '';
          let priorContentSha = '';
          try {
            const parsed = JSON.parse(firstLine.slice(TRACE_PROVENANCE_PREFIX.length)) as Record<string, unknown>;
            priorContentSha = typeof parsed.content_sha256 === 'string' ? parsed.content_sha256 : '';
          } catch {
            // A malformed provenance record must not be silently treated as a
            // successful replay: the operator needs to inspect it explicitly.
          }
          if (priorContentSha !== contentSha256) throw new EvalTraceIdempotencyConflictError();
          return { dataset: existing as EvalDataset, created: false };
        }

        const now = nowIso();
        const [created] = await tx
          .insert(evalDatasets)
          .values(
            datasetValues(
              {
                ...normalizedDataset,
                ground_truth: storedGroundTruth(input.dataset.ground_truth),
                expected_behavior: input.dataset.expected_behavior,
                notes,
                source: 'agent',
                source_session_id: input.source.session_id ?? undefined,
                created_by: input.actor_user_id,
                status: 'active',
              },
              now,
            ),
          )
          .returning();
        return { dataset: created as EvalDataset, created: true };
      });
    },

    async updateDataset(id: number, input: Partial<DatasetInput>): Promise<EvalDataset | null> {
      const existing = await service.getDataset(id);
      if (!existing) return null;

      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (input.category !== undefined) set.category = input.category;
      if (input.difficulty !== undefined) set.difficulty = input.difficulty;
      if (input.question !== undefined) set.question = input.question;
      if (input.ground_truth !== undefined) set.ground_truth = input.ground_truth;
      if (input.expected_behavior !== undefined) set.expected_behavior = input.expected_behavior;
      if (input.tags !== undefined) set.tags = JSON.stringify(input.tags);
      if (input.language !== undefined) set.language = input.language;
      if (input.is_negative !== undefined) set.is_negative = input.is_negative ? 1 : 0;
      if (input.enabled !== undefined) set.enabled = input.enabled ? 1 : 0;
      if (input.updated_by !== undefined) set.updated_by = input.updated_by;
      if (input.notes !== undefined) set.notes = notesWithPreservedTrace(existing.notes, input.notes);
      if (input.status !== undefined) {
        set.status = input.status;
        if (input.status === 'archived' || input.status === 'deprecated') {
          set.archived_at = nowIso();
          set.enabled = 0;
        } else if (input.status === 'active') {
          set.archived_at = null;
        }
      }

      await db.update(evalDatasets).set(set).where(eq(evalDatasets.id, id));
      return service.getDataset(id);
    },

    async deleteDataset(id: number): Promise<boolean> {
      try {
        const deleted = await db.delete(evalDatasets).where(eq(evalDatasets.id, id)).returning({ id: evalDatasets.id });
        return deleted.length > 0;
      } catch (err: any) {
        if (err?.code === '23503') {
          // FK constraint — soft-disable instead of delete
          const updated = await db
            .update(evalDatasets)
            .set({ enabled: 0, updated_at: nowIso() })
            .where(eq(evalDatasets.id, id))
            .returning({ id: evalDatasets.id });
          return updated.length > 0;
        }
        throw err;
      }
    },

    async listDatasets(filters?: DatasetFilters): Promise<EvalDataset[]> {
      const { datasets } = await service.listDatasetsWithTotal(filters);
      return datasets;
    },

    async listDatasetsWithTotal(filters?: DatasetFilters): Promise<{ datasets: EvalDataset[]; total: number }> {
      const conditions = buildDatasetConditions(filters);

      // Whitelist allowed sort columns
      const ALLOWED_SORT_COLS = new Set([
        'id',
        'created_at',
        'updated_at',
        'category',
        'difficulty',
        'language',
        'enabled',
        'is_negative',
        'status',
        'source',
      ]);
      const sortCol = ALLOWED_SORT_COLS.has(filters?.sortBy ?? '') ? filters!.sortBy! : 'id';
      const sortDir = filters?.sortOrder === 'desc' ? 'desc' : 'asc';
      const orderExpr = sortDir === 'desc' ? sql`${sql.raw(sortCol)} DESC` : sql`${sql.raw(sortCol)} ASC`;

      // Count total
      let countQuery = db.select({ count: sql<number>`COUNT(*)` }).from(evalDatasets);
      if (conditions.length > 0) {
        countQuery = countQuery.where(conditions.length === 1 ? conditions[0] : and(...conditions)) as any;
      }
      const countRows = await countQuery;
      const total = Number(countRows[0]?.count ?? 0);

      // Paginated query
      const page = filters?.page ?? 1;
      const pageSize = filters?.page_size ?? 500; // default large for backward compat
      const offset = (page - 1) * pageSize;

      let query = db.select().from(evalDatasets);
      if (conditions.length > 0) {
        query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions)) as any;
      }
      const datasets = (await (query as any).orderBy(orderExpr).limit(pageSize).offset(offset)) as EvalDataset[];

      return { datasets, total };
    },

    async getDataset(id: number): Promise<EvalDataset | null> {
      const rows = await db.select().from(evalDatasets).where(eq(evalDatasets.id, id));
      return (rows[0] as EvalDataset) ?? null;
    },

    async importDatasets(items: DatasetInput[]): Promise<number> {
      let count = 0;
      await db.transaction(async (tx: any) => {
        for (const item of items) {
          const now = nowIso();
          await tx.insert(evalDatasets).values({
            category: item.category,
            difficulty: item.difficulty ?? 'medium',
            question: item.question,
            ground_truth: item.ground_truth,
            expected_behavior: item.expected_behavior ?? null,
            tags: JSON.stringify(item.tags ?? []),
            language: item.language ?? 'en',
            is_negative: item.is_negative ? 1 : 0,
            enabled: item.enabled !== false ? 1 : 0,
            created_by: item.created_by ?? null,
            source: item.source ?? 'import',
            status: item.status ?? 'active',
            notes: item.notes ?? null,
            created_at: now,
            updated_at: now,
          });
          count++;
        }
      });
      return count;
    },

    async batchUpdateDatasets(opts: DatasetBatchOpts): Promise<number> {
      const { action, ids, tags, user_id } = opts;
      if (ids.length === 0) return 0;
      const now = nowIso();
      const where = inArray(evalDatasets.id, ids);

      switch (action) {
        case 'archive': {
          const result = await db
            .update(evalDatasets)
            .set({ status: 'archived', enabled: 0, archived_at: now, updated_at: now, updated_by: user_id ?? null })
            .where(where)
            .returning({ id: evalDatasets.id });
          return result.length;
        }
        case 'restore': {
          const result = await db
            .update(evalDatasets)
            .set({ status: 'active', enabled: 1, archived_at: null, updated_at: now, updated_by: user_id ?? null })
            .where(where)
            .returning({ id: evalDatasets.id });
          return result.length;
        }
        case 'deprecate': {
          const result = await db
            .update(evalDatasets)
            .set({ status: 'deprecated', enabled: 0, archived_at: now, updated_at: now, updated_by: user_id ?? null })
            .where(where)
            .returning({ id: evalDatasets.id });
          return result.length;
        }
        case 'enable': {
          const result = await db
            .update(evalDatasets)
            .set({ enabled: 1, updated_at: now, updated_by: user_id ?? null })
            .where(where)
            .returning({ id: evalDatasets.id });
          return result.length;
        }
        case 'disable': {
          const result = await db
            .update(evalDatasets)
            .set({ enabled: 0, updated_at: now, updated_by: user_id ?? null })
            .where(where)
            .returning({ id: evalDatasets.id });
          return result.length;
        }
        case 'delete': {
          const result = await db.delete(evalDatasets).where(where).returning({ id: evalDatasets.id });
          return result.length;
        }
        case 'add_tags': {
          if (!tags || tags.length === 0) return 0;
          let count = 0;
          const datasets = await db
            .select({ id: evalDatasets.id, tags: evalDatasets.tags })
            .from(evalDatasets)
            .where(where);
          for (const ds of datasets) {
            const existing: string[] = JSON.parse(ds.tags ?? '[]');
            const merged = [...new Set([...existing, ...tags])];
            await db
              .update(evalDatasets)
              .set({ tags: JSON.stringify(merged), updated_at: now, updated_by: user_id ?? null })
              .where(eq(evalDatasets.id, ds.id));
            count++;
          }
          return count;
        }
        case 'remove_tags': {
          if (!tags || tags.length === 0) return 0;
          let count = 0;
          const datasets = await db
            .select({ id: evalDatasets.id, tags: evalDatasets.tags })
            .from(evalDatasets)
            .where(where);
          for (const ds of datasets) {
            const existing: string[] = JSON.parse(ds.tags ?? '[]');
            const filtered = existing.filter((t) => !tags.includes(t));
            await db
              .update(evalDatasets)
              .set({ tags: JSON.stringify(filtered), updated_at: now, updated_by: user_id ?? null })
              .where(eq(evalDatasets.id, ds.id));
            count++;
          }
          return count;
        }
        default:
          return 0;
      }
    },

    // ─── Runs ──────────────────────────────────────────────

    /**
     * Persist an Eval request and all of its case placeholders atomically.
     *
     * The Runtime envelope is deliberately created through `db.runtime` by
     * the API layer so Runtime remains the only writer of Runtime events and
     * outbox rows. A boot reconciler closes the small cross-service crash
     * window between this transaction and Runtime creation.
     */
    async createQueuedRun(opts: QueuedRunCreateOpts): Promise<QueuedRunCreateResult> {
      const datasetIds = [...new Set(opts.datasetIds)];
      if (datasetIds.length === 0 || datasetIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
        throw new Error('datasetIds must contain at least one positive integer');
      }
      return db.transaction(async (tx) => {
        const now = nowIso();
        const id = randomUUID();
        const [created] = await tx
          .insert(evalRuns)
          .values({
            id,
            name: opts.name ?? null,
            status: 'queued',
            total: datasetIds.length,
            completed: 0,
            model: opts.model ?? null,
            profile_id: opts.profileId ?? 'team',
            config: JSON.stringify(opts.config ?? {}),
            // Kept non-null for wire/schema compatibility. Runtime's
            // started_at is the authoritative execution-start timestamp.
            started_at: now,
            created_at: now,
          })
          .returning();
        const results = await tx
          .insert(evalResults)
          .values(
            datasetIds.map((datasetId) => ({
              run_id: id,
              dataset_id: datasetId,
              status: 'pending',
              created_at: now,
            })),
          )
          .returning();
        return { run: created as EvalRun, results: results as EvalResult[] };
      });
    },

    async createRun(opts: RunCreateOpts): Promise<EvalRun> {
      const now = nowIso();
      const id = randomUUID();
      await db.insert(evalRuns).values({
        id,
        name: opts.name ?? null,
        status: 'running',
        total: opts.total,
        completed: 0,
        model: opts.model ?? null,
        profile_id: opts.profileId ?? 'team',
        config: JSON.stringify(opts.config ?? {}),
        started_at: now,
        created_at: now,
      });
      const rows = await db.select().from(evalRuns).where(eq(evalRuns.id, id));
      return rows[0] as EvalRun;
    },

    async getRun(id: string): Promise<EvalRun | null> {
      const rows = await db.select().from(evalRuns).where(eq(evalRuns.id, id));
      return (rows[0] as EvalRun) ?? null;
    },

    async listRuns(limit = 50, search?: string): Promise<EvalRun[]> {
      if (search) {
        const pat = `%${search}%`;
        return (await db
          .select()
          .from(evalRuns)
          .where(or(like(evalRuns.name, pat), like(evalRuns.id, pat)))
          .orderBy(desc(evalRuns.created_at))
          .limit(limit)) as EvalRun[];
      }
      return (await db.select().from(evalRuns).orderBy(desc(evalRuns.created_at)).limit(limit)) as EvalRun[];
    },

    async listRecoverableRuns(limit = 200): Promise<EvalRun[]> {
      return (await db
        .select()
        .from(evalRuns)
        .where(inArray(evalRuns.status, ['queued', 'running']))
        .orderBy(evalRuns.created_at, evalRuns.id)
        .limit(Math.min(Math.max(limit, 1), 1_000))) as EvalRun[];
    },

    async markRunRunning(id: string): Promise<EvalRun | null> {
      const rows = await db
        .update(evalRuns)
        .set({ status: 'running' })
        .where(and(eq(evalRuns.id, id), eq(evalRuns.status, 'queued')))
        .returning();
      if (rows[0]) return rows[0] as EvalRun;
      return service.getRun(id);
    },

    async failRun(id: string): Promise<EvalRun | null> {
      const rows = await db
        .update(evalRuns)
        .set({ status: 'failed', finished_at: nowIso() })
        .where(and(eq(evalRuns.id, id), inArray(evalRuns.status, ['queued', 'running'])))
        .returning();
      if (rows[0]) return rows[0] as EvalRun;
      return service.getRun(id);
    },

    async deleteRun(id: string): Promise<boolean> {
      await db.delete(evalResults).where(eq(evalResults.run_id, id));
      const deleted = await db.delete(evalRuns).where(eq(evalRuns.id, id)).returning({ id: evalRuns.id });
      return deleted.length > 0;
    },

    async updateRunName(id: string, name: string): Promise<EvalRun | null> {
      const existing = await service.getRun(id);
      if (!existing) return null;
      await db.update(evalRuns).set({ name }).where(eq(evalRuns.id, id));
      return service.getRun(id);
    },

    async updateRunProgress(id: string, completed: number): Promise<void> {
      const avgsRows = await db
        .select({
          avg_score: sql<number | null>`AVG(score_final)`,
          avg_accuracy: sql<number | null>`AVG(score_accuracy)`,
          avg_completeness: sql<number | null>`AVG(score_completeness)`,
          avg_relevance: sql<number | null>`AVG(score_relevance)`,
          avg_speed: sql<number | null>`AVG(score_speed)`,
        })
        .from(evalResults)
        .where(and(eq(evalResults.run_id, id), eq(evalResults.status, 'completed')));
      const avgs = avgsRows[0]!;

      const countsRows = await db
        .select({
          passed: sql<number>`COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)`,
          failed: sql<number>`COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0)`,
        })
        .from(evalResults)
        .where(eq(evalResults.run_id, id));
      const counts = countsRows[0]!;

      await db
        .update(evalRuns)
        .set({
          completed,
          passed: counts.passed || 0,
          failed: counts.failed || 0,
          avg_score: avgs.avg_score,
          avg_accuracy: avgs.avg_accuracy,
          avg_completeness: avgs.avg_completeness,
          avg_relevance: avgs.avg_relevance,
          avg_speed: avgs.avg_speed,
        })
        .where(eq(evalRuns.id, id));
    },

    async finalizeRun(id: string): Promise<EvalRun | null> {
      const avgsRows = await db
        .select({
          avg_score: sql<number | null>`AVG(score_final)`,
          avg_accuracy: sql<number | null>`AVG(score_accuracy)`,
          avg_completeness: sql<number | null>`AVG(score_completeness)`,
          avg_relevance: sql<number | null>`AVG(score_relevance)`,
          avg_speed: sql<number | null>`AVG(score_speed)`,
        })
        .from(evalResults)
        .where(and(eq(evalResults.run_id, id), sql`status != 'error'`));
      const avgs = avgsRows[0]!;

      await db
        .update(evalRuns)
        .set({
          status: 'completed',
          avg_score: avgs.avg_score,
          avg_accuracy: avgs.avg_accuracy,
          avg_completeness: avgs.avg_completeness,
          avg_relevance: avgs.avg_relevance,
          avg_speed: avgs.avg_speed,
          finished_at: nowIso(),
        })
        .where(eq(evalRuns.id, id));
      return service.getRun(id);
    },

    async cancelRun(id: string): Promise<void> {
      await db
        .update(evalResults)
        .set({ status: 'cancelled' })
        .where(and(eq(evalResults.run_id, id), eq(evalResults.status, 'pending')));

      const avgsRows = await db
        .select({
          avg_score: sql<number | null>`AVG(score_final)`,
          avg_accuracy: sql<number | null>`AVG(score_accuracy)`,
          avg_completeness: sql<number | null>`AVG(score_completeness)`,
          avg_relevance: sql<number | null>`AVG(score_relevance)`,
          avg_speed: sql<number | null>`AVG(score_speed)`,
        })
        .from(evalResults)
        .where(and(eq(evalResults.run_id, id), eq(evalResults.status, 'completed')));
      const avgs = avgsRows[0]!;

      const countsRows = await db
        .select({
          passed: sql<number>`COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)`,
          failed: sql<number>`COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0)`,
          completed_total: sql<number>`COALESCE(SUM(CASE WHEN status IN ('completed', 'error') THEN 1 ELSE 0 END), 0)`,
        })
        .from(evalResults)
        .where(eq(evalResults.run_id, id));
      const counts = countsRows[0]!;

      await db
        .update(evalRuns)
        .set({
          status: 'cancelled',
          completed: counts.completed_total,
          passed: counts.passed || 0,
          failed: counts.failed || 0,
          avg_score: avgs.avg_score,
          avg_accuracy: avgs.avg_accuracy,
          avg_completeness: avgs.avg_completeness,
          avg_relevance: avgs.avg_relevance,
          avg_speed: avgs.avg_speed,
          finished_at: nowIso(),
        })
        .where(eq(evalRuns.id, id));
    },

    // ─── Results ───────────────────────────────────────────

    async createResult(opts: ResultCreateOpts): Promise<number> {
      const [inserted] = await db
        .insert(evalResults)
        .values({
          run_id: opts.run_id,
          dataset_id: opts.dataset_id,
          session_id: opts.session_id ?? null,
          status: 'pending',
          created_at: nowIso(),
        })
        .returning({ id: evalResults.id });
      return inserted.id;
    },

    async updateResult(id: number, data: ResultUpdateData): Promise<void> {
      const set: Record<string, unknown> = {};
      if (data.answer !== undefined) set.answer = data.answer;
      if (data.references_used !== undefined) set.references_used = JSON.stringify(data.references_used);
      if (data.duration_ms !== undefined) set.duration_ms = data.duration_ms;
      if (data.ttfb_ms !== undefined) set.ttfb_ms = data.ttfb_ms;
      if (data.answer_length !== undefined) set.answer_length = data.answer_length;
      if (data.session_id !== undefined) set.session_id = data.session_id;
      if (data.score_accuracy !== undefined) set.score_accuracy = data.score_accuracy;
      if (data.score_completeness !== undefined) set.score_completeness = data.score_completeness;
      if (data.score_relevance !== undefined) set.score_relevance = data.score_relevance;
      if (data.score_speed !== undefined) set.score_speed = data.score_speed;
      if (data.score_final !== undefined) set.score_final = data.score_final;
      if (data.judge_reasoning !== undefined) set.judge_reasoning = JSON.stringify(data.judge_reasoning);
      if (data.status !== undefined) set.status = data.status;
      if (data.error !== undefined) set.error = data.error;

      if (Object.keys(set).length === 0) return;
      await db.update(evalResults).set(set).where(eq(evalResults.id, id));
    },

    /** Cancellation wins races with a late provider response. */
    async updatePendingResult(id: number, data: ResultUpdateData): Promise<boolean> {
      const set: Record<string, unknown> = {};
      if (data.answer !== undefined) set.answer = data.answer;
      if (data.references_used !== undefined) set.references_used = JSON.stringify(data.references_used);
      if (data.duration_ms !== undefined) set.duration_ms = data.duration_ms;
      if (data.ttfb_ms !== undefined) set.ttfb_ms = data.ttfb_ms;
      if (data.answer_length !== undefined) set.answer_length = data.answer_length;
      if (data.session_id !== undefined) set.session_id = data.session_id;
      if (data.score_accuracy !== undefined) set.score_accuracy = data.score_accuracy;
      if (data.score_completeness !== undefined) set.score_completeness = data.score_completeness;
      if (data.score_relevance !== undefined) set.score_relevance = data.score_relevance;
      if (data.score_speed !== undefined) set.score_speed = data.score_speed;
      if (data.score_final !== undefined) set.score_final = data.score_final;
      if (data.judge_reasoning !== undefined) set.judge_reasoning = JSON.stringify(data.judge_reasoning);
      if (data.status !== undefined) set.status = data.status;
      if (data.error !== undefined) set.error = data.error;
      if (Object.keys(set).length === 0) return false;
      const rows = await db
        .update(evalResults)
        .set(set)
        .where(and(eq(evalResults.id, id), eq(evalResults.status, 'pending')))
        .returning({ id: evalResults.id });
      return rows.length === 1;
    },

    async listResults(runId: string): Promise<EvalResult[]> {
      return (await db
        .select()
        .from(evalResults)
        .where(eq(evalResults.run_id, runId))
        .orderBy(evalResults.dataset_id, evalResults.id)) as EvalResult[];
    },

    async getRunResults(runId: string): Promise<EvalResultWithQuestion[]> {
      const result = await db.execute(sql`
        SELECT r.*, d.question, d.category, d.difficulty, d.ground_truth,
               d.is_negative, d.tags, d.language,
               m.input_tokens AS msg_input_tokens, m.output_tokens AS msg_output_tokens,
               m.cached_tokens, m.reasoning_tokens, m.pipeline
        FROM eval_results r
        JOIN eval_datasets d ON r.dataset_id = d.id
        LEFT JOIN messages m ON m.session_id = r.session_id AND m.role = 'assistant'
        WHERE r.run_id = ${runId}
        ORDER BY d.id ASC
      `);
      return result as unknown as EvalResultWithQuestion[];
    },

    async compareRuns(runIds: string[]): Promise<RunComparison> {
      const runs = (await Promise.all(runIds.map((id) => service.getRun(id)))).filter(Boolean) as EvalRun[];
      const results = new Map<number, Record<string, EvalResultWithQuestion>>();

      for (const run of runs) {
        const runResults = await service.getRunResults(run.id);
        for (const r of runResults) {
          if (!results.has(r.dataset_id)) results.set(r.dataset_id, {});
          results.get(r.dataset_id)![run.id] = r;
        }
      }

      return { runs, results };
    },
  };

  function buildDatasetConditions(filters?: DatasetFilters) {
    const conditions = [];
    if (filters?.category) conditions.push(eq(evalDatasets.category, filters.category));
    if (filters?.difficulty) conditions.push(eq(evalDatasets.difficulty, filters.difficulty));
    if (filters?.language) conditions.push(eq(evalDatasets.language, filters.language));
    if (filters?.enabled !== undefined) conditions.push(eq(evalDatasets.enabled, filters.enabled ? 1 : 0));
    if (filters?.status) conditions.push(eq(evalDatasets.status, filters.status));
    if (filters?.source) conditions.push(eq(evalDatasets.source, filters.source));
    if (filters?.created_by) conditions.push(eq(evalDatasets.created_by, filters.created_by));
    if (filters?.created_after) conditions.push(gte(evalDatasets.created_at, filters.created_after));
    if (filters?.created_before) conditions.push(lte(evalDatasets.created_at, filters.created_before));
    if (filters?.search) {
      const pat = `%${filters.search}%`;
      conditions.push(or(like(evalDatasets.question, pat), like(evalDatasets.ground_truth, pat))!);
    }
    if (filters?.tags && filters.tags.length > 0) {
      // Match all tags (AND logic) — each tag must appear in the JSON array
      for (const tag of filters.tags) {
        conditions.push(sql`${evalDatasets.tags}::text LIKE ${'%"' + tag + '"%'}`);
      }
    }
    return conditions;
  }

  return service;
}

export type EvalService = ReturnType<typeof createEvalService>;
