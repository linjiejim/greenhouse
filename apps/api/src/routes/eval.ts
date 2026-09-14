/**
 * Eval routes — /api/eval
 *
 * === 评测题库 ===
 * GET    /api/eval/datasets         — 获取评测题库列表（支持category/difficulty/language/enabled/search/sort_by/sort_order筛选）
 * POST   /api/eval/datasets         — 新建评测题目
 * PUT    /api/eval/datasets/:id     — 更新评测题目
 * DELETE /api/eval/datasets/:id     — 删除评测题目
 * POST   /api/eval/datasets/import  — 批量导入评测题目
 * POST   /api/eval/datasets/seed    — 初始化种子评测数据
 * GET    /api/eval/datasets/from-runtime/:runId/preview — 预览 Runtime 证据生成的可编辑用例（不写库）
 * POST   /api/eval/datasets/from-runtime/:runId         — 显式确认后创建可追溯用例
 *
 * === 评测运行 ===
 * GET    /api/eval/runs              — 获取评测运行列表
 * POST   /api/eval/runs              — 创建并执行评测运行
 * GET    /api/eval/runs/:id          — 获取评测运行详情及结果
 * PATCH  /api/eval/runs/:id          — 更新评测运行名称
 * DELETE /api/eval/runs/:id          — 删除评测运行
 * POST   /api/eval/runs/:id/cancel   — 取消运行中的评测
 *
 * === 评测对比 ===
 * GET    /api/eval/compare           — 对比多个评测运行结果（需>=2个run_ids）
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { EvalTraceIdempotencyConflictError, getDb } from '@greenhouse/db';
import type { DatasetInput } from '../eval.js';
import type {
  EvalResultWithQuestion,
  RuntimeDatasetCreateInput,
  RuntimeDatasetDraft,
  RuntimeDatasetEvidence,
  RuntimeDatasetPreview,
  RuntimeDatasetPreviewWarning,
  RuntimeDatasetTraceSource,
} from '@greenhouse/types/eval';
import type { RuntimeJsonValue, RuntimeRun } from '@greenhouse/types/runtime';
import { SEED_DATASETS } from '@greenhouse/db/seeds/eval-seed';
import { resolveProfileAsync } from '../profiles/profile.js';
import { pinProfileIdForUser, ProfileAccessError } from '../profiles/access.js';
import { getAuthUser } from '../auth/middleware.js';
import type { DatasetBatchAction } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';
import {
  runtimeArtifactView,
  runtimeEventView,
  runtimeInterruptView,
  runtimeRunView,
  runtimeStepView,
  runtimeToolCallView,
} from '../runtime/views.js';
import { ensureEvalRuntimeRun, settleQueuedEvalCancellation } from '../runtime/eval-driver.js';
import { resolveTrustedExecutionSwitches, trustedExecutionBootPlan } from '../trusted-execution/kill-switches.js';

const TRACE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,256}$/;

function trustedExecutionPlan() {
  return trustedExecutionBootPlan(resolveTrustedExecutionSwitches());
}
const SENSITIVE_KEY_RE = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
const SENSITIVE_VALUE_RES = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:^|\D)(?:\+?86[- ]?)?1[3-9]\d{9}(?:\D|$)/,
];

function traceSource(run: RuntimeRun): RuntimeDatasetTraceSource {
  return {
    runtime_run_id: run.id,
    runtime_kind: run.kind,
    runtime_status: run.status,
    source_kind: run.source_kind,
    source_id: run.source_id,
    session_id: run.session_id,
  };
}

function objectString(value: RuntimeJsonValue | null, keys: readonly string[]): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const candidate = objectString(child, keys);
      if (candidate !== undefined) return candidate;
    }
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  for (const child of Object.values(value)) {
    const candidate = objectString(child, keys);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function pickEvalEvidence(results: readonly EvalResultWithQuestion[]): EvalResultWithQuestion | undefined {
  return [...results].sort((left, right) => {
    const leftFailed = left.status === 'error' || !!left.error;
    const rightFailed = right.status === 'error' || !!right.error;
    if (leftFailed !== rightFailed) return leftFailed ? -1 : 1;
    return (left.score_final ?? Number.POSITIVE_INFINITY) - (right.score_final ?? Number.POSITIVE_INFINITY);
  })[0];
}

function editableGroundTruth(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const facts = JSON.parse(value) as unknown;
    if (Array.isArray(facts) && facts.every((fact) => typeof fact === 'string')) return facts.join('\n');
  } catch {
    // Runtime payload suggestions are often plain text rather than Eval's
    // persisted JSON string array. Keep that text editable as-is.
  }
  return value;
}

function parsedStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const items = JSON.parse(value) as unknown;
    return Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function sensitivePaths(value: unknown, path = 'evidence', found = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    value.forEach((child, index) => sensitivePaths(child, `${path}[${index}]`, found));
    return [...found];
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (SENSITIVE_KEY_RE.test(key) && child !== null && child !== '') found.add(childPath);
      sensitivePaths(child, childPath, found);
    }
    return [...found];
  }
  if (typeof value === 'string' && SENSITIVE_VALUE_RES.some((pattern) => pattern.test(value))) found.add(path);
  return [...found];
}

function draftFromEvidence(evidence: RuntimeDatasetEvidence): {
  draft: RuntimeDatasetDraft;
  groundTruthNeedsReview: boolean;
} {
  const selectedEval = pickEvalEvidence(evidence.eval_results);
  const latestUserMessage = evidence.session_messages.filter((message) => message.role === 'user').at(-1)?.content;
  const question =
    selectedEval?.question ||
    latestUserMessage ||
    objectString(evidence.run.input, ['question', 'prompt', 'task', 'message', 'title']) ||
    evidence.run.error_message ||
    `Reproduce Runtime ${evidence.run.kind} run ${evidence.run.id}`;
  const explicitGroundTruth = editableGroundTruth(
    selectedEval?.ground_truth || objectString(evidence.run.input, ['ground_truth', 'expected_output', 'expected']),
  );
  const outputSuggestion = editableGroundTruth(
    objectString(evidence.run.output, ['ground_truth', 'answer', 'result', 'summary', 'content']),
  );
  const groundTruth = explicitGroundTruth || outputSuggestion || '';
  const failure = ['failed', 'canceled', 'interrupted'].includes(evidence.run.status);
  const tags = [
    ...parsedStringArray(selectedEval?.tags),
    'runtime-trace',
    evidence.run.kind,
    `status:${evidence.run.status}`,
  ].filter((tag, index, all) => all.indexOf(tag) === index);
  return {
    draft: {
      category: selectedEval?.category || (failure ? 'negative' : 'edge'),
      difficulty: selectedEval?.difficulty || 'medium',
      question,
      ground_truth: groundTruth,
      expected_behavior: failure
        ? `The task should complete without the recorded failure${evidence.run.error_message ? `: ${evidence.run.error_message}` : '.'}`
        : '',
      tags,
      language: selectedEval?.language || (/[\u3400-\u9fff]/u.test(question) ? 'zh' : 'en'),
      is_negative: selectedEval ? selectedEval.is_negative === 1 : failure,
      enabled: true,
      notes: '',
    },
    groundTruthNeedsReview: !explicitGroundTruth,
  };
}

async function runtimeDatasetEvidence(runId: string): Promise<RuntimeDatasetEvidence | null> {
  const detail = await getDb().runtime.getRunDetail(runId);
  if (!detail) return null;
  const run = runtimeRunView(detail.run);
  let evalResults: EvalResultWithQuestion[] = [];
  if (run.kind === 'eval' && (await getDb().eval.getRun(run.source_id))) {
    evalResults = await getDb().eval.getRunResults(run.source_id);
  }
  let sessionMessages: RuntimeDatasetEvidence['session_messages'] = [];
  if (run.session_id) {
    const messageCount = await getDb().sessions.getMessageCount(run.session_id);
    sessionMessages =
      messageCount > 0 ? await getDb().sessions.getMessages(run.session_id, { limit: messageCount }) : [];
  }
  return {
    run,
    events: detail.events.map(runtimeEventView),
    steps: detail.steps.map(runtimeStepView),
    tool_calls: detail.tool_calls.map(runtimeToolCallView),
    artifacts: detail.artifacts.map(runtimeArtifactView),
    interrupts: detail.interrupts.map(runtimeInterruptView),
    eval_results: evalResults,
    session_messages: sessionMessages,
  };
}

function validateTraceDraft(value: unknown): RuntimeDatasetDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  if (
    typeof draft.category !== 'string' ||
    !draft.category.trim() ||
    typeof draft.difficulty !== 'string' ||
    !draft.difficulty.trim() ||
    typeof draft.question !== 'string' ||
    !draft.question.trim() ||
    typeof draft.ground_truth !== 'string' ||
    !draft.ground_truth.trim() ||
    typeof draft.expected_behavior !== 'string' ||
    !Array.isArray(draft.tags) ||
    !draft.tags.every((tag) => typeof tag === 'string') ||
    typeof draft.language !== 'string' ||
    !draft.language.trim() ||
    typeof draft.is_negative !== 'boolean' ||
    typeof draft.enabled !== 'boolean' ||
    typeof draft.notes !== 'string'
  ) {
    return null;
  }
  return {
    category: draft.category,
    difficulty: draft.difficulty,
    question: draft.question,
    ground_truth: draft.ground_truth,
    expected_behavior: draft.expected_behavior,
    tags: draft.tags as string[],
    language: draft.language,
    is_negative: draft.is_negative,
    enabled: draft.enabled,
    notes: draft.notes,
  };
}

function buildRuntimeDatasetPreview(evidence: RuntimeDatasetEvidence): RuntimeDatasetPreview {
  const { draft, groundTruthNeedsReview } = draftFromEvidence(evidence);
  const paths = sensitivePaths(evidence);
  const warnings: RuntimeDatasetPreviewWarning[] = [
    {
      code: 'sensitive_content',
      message:
        paths.length > 0
          ? 'Potential secrets or personal data were detected. Evidence is complete and unredacted; review the draft before capture.'
          : 'Runtime evidence is complete and unredacted and may contain sensitive data; review the draft before capture.',
      paths,
    },
  ];
  if (groundTruthNeedsReview) {
    warnings.push({
      code: 'ground_truth_review',
      message: 'Ground truth was inferred from Runtime output or is empty and must be verified before capture.',
      paths: ['draft.ground_truth'],
    });
  }
  return {
    source: traceSource(evidence.run),
    draft,
    evidence,
    warnings,
  };
}

function getUserId(c: any): string | undefined {
  try {
    return getAuthUser(c)?.id;
  } catch {
    return undefined;
  }
}

const evalRoutes = new Hono<AppEnv>()
  // ─── Datasets ────────────────────────────────────────────

  /** GET /api/eval/datasets — list eval datasets */
  .get('/datasets', async (c) => {
    const category = c.req.query('category') || undefined;
    const difficulty = c.req.query('difficulty') || undefined;
    const language = c.req.query('language') || undefined;
    const enabled = c.req.query('enabled');
    const search = c.req.query('search') || undefined;
    const sortBy = (c.req.query('sort_by') || undefined) as 'id' | 'created_at' | 'updated_at' | undefined;
    const sortOrder = (c.req.query('sort_order') || undefined) as 'asc' | 'desc' | undefined;
    const status = c.req.query('status') || undefined;
    const source = c.req.query('source') || undefined;
    const tagsParam = c.req.query('tags');
    const tags = tagsParam ? tagsParam.split(',').filter(Boolean) : undefined;
    const created_by = c.req.query('created_by') || undefined;
    const created_after = c.req.query('created_after') || undefined;
    const created_before = c.req.query('created_before') || undefined;
    const page = c.req.query('page') ? parseInt(c.req.query('page')!, 10) : undefined;
    const page_size = c.req.query('page_size') ? parseInt(c.req.query('page_size')!, 10) : undefined;

    const { datasets, total } = await getDb().eval.listDatasetsWithTotal({
      category,
      difficulty,
      language,
      search,
      sortBy,
      sortOrder,
      status,
      source,
      tags,
      created_by,
      created_after,
      created_before,
      page,
      page_size,
      enabled: enabled === '1' ? true : enabled === '0' ? false : undefined,
    });
    return c.json({ datasets, total });
  })
  .post('/datasets', async (c) => {
    const body = (await c.req.json()) as DatasetInput;
    const userId = getUserId(c);

    // Validate required fields
    if (!body.question?.trim()) {
      return c.json({ error: 'Missing required field: question' }, 400);
    }
    if (!body.ground_truth?.trim()) {
      return c.json({ error: 'Missing required field: ground_truth' }, 400);
    }
    if (!body.category?.trim()) {
      return c.json({ error: 'Missing required field: category' }, 400);
    }

    const dataset = await getDb().eval.createDataset({
      ...body,
      created_by: body.created_by ?? userId ?? null,
      source: body.source ?? 'manual',
    } as DatasetInput);
    return c.json(dataset, 201);
  })
  .put('/datasets/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const body = (await c.req.json()) as Partial<DatasetInput>;
    const userId = getUserId(c);
    body.updated_by = userId;
    const dataset = await getDb().eval.updateDataset(id, body);
    if (!dataset) return c.json({ error: 'Dataset not found' }, 404);
    return c.json(dataset);
  })
  .delete('/datasets/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const ok = await getDb().eval.deleteDataset(id);
    if (!ok) return c.json({ error: 'Dataset not found' }, 404);
    return c.json({ ok: true });
  })
  .post('/datasets/import', async (c) => {
    const body = (await c.req.json()) as { datasets: DatasetInput[] };
    const user = getAuthUser(c);
    const datasets = body.datasets.map((d) => ({
      ...d,
      created_by: d.created_by ?? user?.id,
      source: d.source ?? 'import',
    }));
    const count = await getDb().eval.importDatasets(datasets);
    return c.json({ imported: count });
  })
  .post('/datasets/seed', async (c) => {
    const existing = await getDb().eval.listDatasets();
    if (existing.length > 0) {
      return c.json({ error: 'Datasets already exist. Delete them first or use import.' }, 400);
    }
    const seeds = SEED_DATASETS.map((d) => ({ ...d, source: 'seed' as const }));
    const count = await getDb().eval.importDatasets(seeds);
    return c.json({ seeded: count });
  })
  /** POST /api/eval/datasets/batch — batch operations */
  .post('/datasets/batch', async (c) => {
    const body = (await c.req.json()) as { action: DatasetBatchAction; ids: number[]; tags?: string[] };
    const user = getAuthUser(c);

    if (!body.action || !body.ids || body.ids.length === 0) {
      return c.json({ error: 'action and ids are required' }, 400);
    }

    const VALID_ACTIONS = ['archive', 'restore', 'delete', 'enable', 'disable', 'add_tags', 'remove_tags', 'deprecate'];
    if (!VALID_ACTIONS.includes(body.action)) {
      return c.json({ error: `Invalid action: ${body.action}` }, 400);
    }

    const count = await getDb().eval.batchUpdateDatasets({
      action: body.action,
      ids: body.ids,
      tags: body.tags,
      user_id: user?.id,
    });
    return c.json({ affected: count });
  })
  .get('/datasets/from-runtime/:runId/preview', async (c) => {
    if (!trustedExecutionPlan().taskCenter) {
      return c.json(
        { error: 'Execution Center is unavailable in this environment', code: 'task_center_disabled' },
        503,
      );
    }
    const user = getAuthUser(c);
    if (user.role !== 'super') return c.json({ error: 'Super role required' }, 403);
    const evidence = await runtimeDatasetEvidence(c.req.param('runId'));
    if (!evidence) return c.json({ error: 'Runtime run not found' }, 404);
    return c.json(buildRuntimeDatasetPreview(evidence));
  })
  .post('/datasets/from-runtime/:runId', async (c) => {
    if (!trustedExecutionPlan().taskCenter) {
      return c.json(
        { error: 'Execution Center is unavailable in this environment', code: 'task_center_disabled' },
        503,
      );
    }
    const user = getAuthUser(c);
    if (user.role !== 'super') return c.json({ error: 'Super role required' }, 403);
    const body = (await c.req.json().catch(() => null)) as RuntimeDatasetCreateInput | null;
    if (!body || typeof body.idempotency_key !== 'string' || !TRACE_IDEMPOTENCY_KEY_RE.test(body.idempotency_key)) {
      return c.json({ error: 'idempotency_key is malformed' }, 400);
    }
    const dataset = validateTraceDraft(body.dataset);
    if (!dataset) {
      return c.json({ error: 'dataset fields are malformed; question and ground_truth are required' }, 400);
    }
    const evidence = await runtimeDatasetEvidence(c.req.param('runId'));
    if (!evidence) return c.json({ error: 'Runtime run not found' }, 404);
    const source = traceSource(evidence.run);
    try {
      const result = await getDb().eval.createDatasetFromRuntimeTrace({
        source,
        dataset,
        actor_user_id: user.id,
        idempotency_key: body.idempotency_key,
      });
      logger.info('Captured Runtime trace as Eval Dataset', {
        dataset_id: result.dataset.id,
        runtime_run_id: source.runtime_run_id,
        user_id: user.id,
        created: result.created,
      });
      const response = { dataset: result.dataset, created: result.created, source };
      return result.created ? c.json(response, 201) : c.json(response, 200);
    } catch (error) {
      if (error instanceof EvalTraceIdempotencyConflictError) {
        return c.json({ error: error.message, code: 'trace_idempotency_conflict' }, 409);
      }
      throw error;
    }
  })
  // ─── Runs ────────────────────────────────────────────────

  /** GET /api/eval/runs — list eval runs */
  .get('/runs', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const search = c.req.query('search') || undefined;
    const runs = await getDb().eval.listRuns(limit, search);
    return c.json({ runs });
  })
  .post('/runs', async (c) => {
    if (!trustedExecutionPlan().evalDriver) {
      return c.json({ error: 'Durable Eval driver is disabled', code: 'runtime_eval_driver_disabled' }, 503);
    }
    const actor = getAuthUser(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      concurrency?: number;
      profile_id?: string;
      dataset_ids?: number[];
    };
    const concurrency =
      body.concurrency && body.concurrency >= 1 && body.concurrency <= 50 ? body.concurrency : undefined;
    let profileId: string;
    let model: string;

    try {
      profileId = await pinProfileIdForUser(actor, body.profile_id);
      const profile = await resolveProfileAsync(profileId);
      model = profile.model.id ?? profile.model.model ?? profileId;
    } catch (err) {
      if (err instanceof ProfileAccessError) return c.json({ error: err.message }, err.status);
      return c.json({ error: `Profile not found: ${body.profile_id ?? 'team'}` }, 400);
    }

    try {
      const currentActor = await getDb().users.getById(actor.id);
      if (!currentActor || currentActor.status !== 'active' || currentActor.role !== 'super') {
        return c.json({ error: 'Authenticated account is no longer available' }, 401);
      }

      const datasets = await getDb().eval.listDatasets({ enabled: true });
      if (datasets.length === 0) return c.json({ error: 'No enabled datasets found' }, 400);

      // Filter to selected dataset_ids if provided
      const selectedDatasets =
        body.dataset_ids && body.dataset_ids.length > 0
          ? datasets.filter((d) => body.dataset_ids!.includes(d.id))
          : datasets;
      if (selectedDatasets.length === 0) return c.json({ error: 'No matching datasets found for the given IDs' }, 400);

      const datasetIds = selectedDatasets.map((dataset) => dataset.id);
      const queued = await getDb().eval.createQueuedRun({
        name: body.name,
        total: datasetIds.length,
        model,
        profileId,
        datasetIds,
        config: {
          actor_user_id: currentActor.id,
          concurrency: concurrency ?? 5,
          profile_id: profileId,
          dataset_ids: datasetIds,
          agent_timeout_ms: 150_000,
        },
      });
      try {
        await ensureEvalRuntimeRun(getDb(), queued.run);
      } catch (error) {
        await getDb().eval.failRun(queued.run.id);
        throw error;
      }
      return c.json(queued.run, 201);
    } catch (err) {
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  })
  .get('/runs/:id', async (c) => {
    const id = c.req.param('id');
    const run = await getDb().eval.getRun(id);
    if (!run) return c.json({ error: 'Run not found' }, 404);
    const results = await getDb().eval.getRunResults(id);
    return c.json({ run, results });
  })
  .delete('/runs/:id', async (c) => {
    const id = c.req.param('id');
    const run = await getDb().eval.getRun(id);
    if (run?.status === 'running' || run?.status === 'queued') {
      return c.json({ error: 'Cancel the durable Eval run before deleting it' }, 409);
    }
    const ok = await getDb().eval.deleteRun(id);
    if (!ok) return c.json({ error: 'Run not found' }, 404);
    return c.json({ ok: true });
  })
  /** POST /api/eval/runs/:id/cancel — 取消运行中的评测 */
  .post('/runs/:id/cancel', async (c) => {
    const actor = getAuthUser(c);
    const id = c.req.param('id');
    const run = await getDb().eval.getRun(id);
    if (!run) return c.json({ error: 'Run not found' }, 404);
    if (run.status === 'cancelled') return c.json(run);
    if (run.status !== 'running' && run.status !== 'queued') {
      return c.json({ error: `Run is not active (status: ${run.status})` }, 400);
    }
    let runtime = await getDb().runtime.getRunBySource('eval', 'eval_run', id);
    if (!runtime) runtime = await ensureEvalRuntimeRun(getDb(), run);
    const fenced = await getDb().runtime.executeRunDomainCommand(
      {
        type: 'cancel',
        run_id: runtime.id,
        expected_version: runtime.version,
        idempotency_key: `eval-cancel:${randomUUID()}`,
      },
      actor.id,
      async ({ may_drive: mayDrive }) => {
        const source = await getDb().eval.getRun(id);
        if (!source) throw new Error('Eval source run is missing');
        if (source.status === 'cancelled') return;
        if (!mayDrive) throw new Error('Eval Runtime changed concurrently');
        if (source.status !== 'running' && source.status !== 'queued') {
          throw new Error(`Eval run is already ${source.status}`);
        }
        await getDb().eval.cancelRun(id);
      },
    );
    await settleQueuedEvalCancellation(getDb(), fenced.run, actor.id);
    const updatedRun = await getDb().eval.getRun(id);
    return c.json(updatedRun);
  })
  .patch('/runs/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { name?: string };
    if (body.name === undefined) return c.json({ error: 'Nothing to update' }, 400);
    const run = await getDb().eval.updateRunName(id, body.name);
    if (!run) return c.json({ error: 'Run not found' }, 404);
    return c.json(run);
  })
  // ─── Compare ─────────────────────────────────────────────

  .get('/compare', async (c) => {
    const ids = (c.req.query('run_ids') ?? '').split(',').filter(Boolean);
    if (ids.length < 2) return c.json({ error: 'Need at least 2 run_ids' }, 400);
    const comparison = await getDb().eval.compareRuns(ids);
    const resultsObj: Record<number, Record<string, unknown>> = {};
    comparison.results.forEach((val, key) => {
      resultsObj[key] = val;
    });
    return c.json({ runs: comparison.runs, results: resultsObj });
  });

export default evalRoutes;
