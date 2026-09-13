/**
 * Evaluation module — types, LLM-as-Judge scorer, agent caller, and run engine.
 *
 * All CRUD operations live in @greenhouse/db services/eval.ts (EvalService).
 */

import type { EvalService } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { extractJson } from '@greenhouse/utils/json';
import { runWithConcurrency } from '@greenhouse/utils/concurrency';
import { scoreDimension } from './llm/judge.js';
import { complete } from './llm/complete.js';
import { BATCH_EVAL_JUDGE_PROFILE } from './llm/tasks/batch-eval-judge.js';
import { pinProfileVersion, resolveProfileAsync } from './profile.js';

// Re-export for convenience
export { extractJson };

// ─── Types (canonical definitions in src/types/eval.ts) ──

import type { EvalDataset, EvalRun, EvalResult, EvalResultWithQuestion, DatasetInput } from '@greenhouse/types/eval';

export type { EvalDataset, EvalRun, EvalResult, EvalResultWithQuestion, DatasetInput };

// ─── Speed Scoring ───────────────────────────────────────
//
// Speed is evaluated on two dimensions:
//   1. TTFB (Time-To-First-Byte)  — how fast the agent starts responding.
//      Weight: 60%
//   2. Throughput — characters generated per second (answer_length / total_time).
//      Weight: 40%
//
// Both are scored 1-10 and blended into a single speed score.

const TTFB_THRESHOLDS = [
  { maxMs: 1_500, score: 10 },
  { maxMs: 3_000, score: 9 },
  { maxMs: 5_000, score: 8 },
  { maxMs: 8_000, score: 7 },
  { maxMs: 12_000, score: 6 },
  { maxMs: 18_000, score: 5 },
  { maxMs: 25_000, score: 4 },
  { maxMs: 35_000, score: 3 },
];

const THROUGHPUT_THRESHOLDS = [
  { minCps: 150, score: 10 },
  { minCps: 100, score: 9 },
  { minCps: 70, score: 8 },
  { minCps: 50, score: 7 },
  { minCps: 35, score: 6 },
  { minCps: 20, score: 5 },
  { minCps: 10, score: 4 },
  { minCps: 5, score: 3 },
];

export function computeSpeedScore(opts: { ttfbMs: number; totalMs: number; answerLength: number }): {
  score: number;
  ttfbScore: number;
  throughputScore: number;
  throughputCps: number;
} {
  let ttfbScore = 2;
  for (const t of TTFB_THRESHOLDS) {
    if (opts.ttfbMs <= t.maxMs) {
      ttfbScore = t.score;
      break;
    }
  }

  const genTimeMs = Math.max(opts.totalMs - opts.ttfbMs, 1);
  const cps = (opts.answerLength / genTimeMs) * 1000;
  let throughputScore = 2;
  for (const t of THROUGHPUT_THRESHOLDS) {
    if (cps >= t.minCps) {
      throughputScore = t.score;
      break;
    }
  }

  const score = Math.round((ttfbScore * 0.6 + throughputScore * 0.4) * 10) / 10;
  return { score, ttfbScore, throughputScore, throughputCps: Math.round(cps) };
}

// ─── Scoring Weights ─────────────────────────────────────

const WEIGHTS = {
  accuracy: 0.4,
  completeness: 0.3,
  relevance: 0.15,
  speed: 0.15,
};

export function computeFinalScore(scores: {
  accuracy: number;
  completeness: number;
  relevance: number;
  speed: number;
}): number {
  const final =
    scores.accuracy * WEIGHTS.accuracy +
    scores.completeness * WEIGHTS.completeness +
    scores.relevance * WEIGHTS.relevance +
    scores.speed * WEIGHTS.speed;
  return Math.round(final * 10) / 10;
}

// ─── LLM Judge ───────────────────────────────────────────

export async function judgeAnswer(
  question: string,
  groundTruth: string[],
  answer: string,
  references: string[],
  isNegative: boolean,
  userId: string,
  maxRetries = 2,
  abortSignal?: AbortSignal,
): Promise<{
  accuracy: { score: number; reason: string };
  completeness: { score: number; reason: string };
  relevance: { score: number; reason: string };
}> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (abortSignal?.aborted) throw abortSignal.reason;
      const result = await _judgeAnswerOnce(question, groundTruth, answer, references, isNegative, userId, abortSignal);
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isRetryable =
        lastError.message.includes('无法解析评分JSON') ||
        lastError.message.includes('Cannot extract JSON') ||
        lastError.message.includes('Cannot parse') ||
        lastError.message.includes('429') ||
        lastError.message.includes('500') ||
        lastError.message.includes('502') ||
        lastError.message.includes('503');

      if (!isRetryable || attempt >= maxRetries) break;
      const delayMs = 1000 * (attempt + 1);
      logger.warn(
        `[Judge] ⚠️ Attempt ${attempt + 1} failed: ${lastError.message.slice(0, 80)}, retrying in ${delayMs}ms...`,
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        abortSignal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(abortSignal.reason);
          },
          { once: true },
        );
      });
    }
  }

  throw lastError!;
}

async function _judgeAnswerOnce(
  question: string,
  groundTruth: string[],
  answer: string,
  references: string[],
  isNegative: boolean,
  userId: string,
  abortSignal?: AbortSignal,
): Promise<{
  accuracy: { score: number; reason: string };
  completeness: { score: number; reason: string };
  relevance: { score: number; reason: string };
}> {
  const negativeInstructions = isNegative
    ? `
## ⚠️ 这是一道反面测试题
该题目的预期行为是Agent应当**拒绝回答、承认不知道、或建议联系官方客服**。
- accuracy: Agent正确拒绝/承认不知道 = 高分(8-10)；如果瞎编答案 = 低分(1-3)
- completeness: Agent是否给出了合理的替代建议（如联系客服、查看官网等）
- relevance: 不要求引用参考资料，但如果引用了不相关内容扣分`
    : '';

  const userPrompt = `## 用户问题
${question}

## 预期关键事实 (Ground Truth)
${groundTruth.map((f, i) => `${i + 1}. ${f}`).join('\n')}
${negativeInstructions}

## Agent的实际回答
${answer || '(未提供回答)'}

## Agent引用的参考资料
${references.length > 0 ? references.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(无)'}

## 评分维度
- accuracy (准确性): 回答中的事实陈述是否正确，数值参数（EC、pH、温度等）是否准确无误
- completeness (完整性): 是否覆盖了预期的关键知识点，重要信息是否有遗漏。满分=全部覆盖，一半=5分
- relevance (引用相关性): 是否引用了相关的知识库文档，引用是否准确。无引用=4-5分，错误引用=1-3分

## 输出格式
返回以下JSON结构（理由用中文）：
{
  "accuracy": { "score": <1-10>, "reason": "<一句话说明>" },
  "completeness": { "score": <1-10>, "reason": "<一句话说明>" },
  "relevance": { "score": <1-10>, "reason": "<一句话说明>" }
}`;

  const profile = BATCH_EVAL_JUDGE_PROFILE;
  logger.info(`[Judge] Using task config: batch-eval-judge (model=${profile.model.model})`);

  const result = await complete(profile, {
    messages: [{ role: 'user', content: userPrompt }],
    caller: 'judge',
    userId,
    responseFormat: 'json',
    abortSignal,
  });

  logger.info(`[Judge] ✅ Response received (${result.text.length} chars)`);

  const jsonText = extractJson(result.text);
  if (!jsonText) {
    logger.error(
      `[Judge] ⚠️ Cannot parse JSON from response (${result.text.length} chars): ${result.text.slice(0, 300)}`,
    );
    throw new Error(`无法解析评分JSON: ${result.text.slice(0, 300)}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`无法解析评分JSON (parse error): ${(e as Error).message}`);
  }

  if (!parsed.accuracy || !parsed.completeness || !parsed.relevance) {
    throw new Error(`无法解析评分JSON: missing required keys (got: ${Object.keys(parsed).join(', ')})`);
  }

  return {
    accuracy: scoreDimension(parsed.accuracy),
    completeness: scoreDimension(parsed.completeness),
    relevance: scoreDimension(parsed.relevance),
  };
}

// ─── Agent Caller ────────────────────────────────────────

export interface AgentReference {
  slug: string;
  title: string;
  category?: string;
}

export interface AgentResponse {
  answer: string;
  references: AgentReference[];
  durationMs: number;
  ttfbMs: number;
  sessionId: string;
}

export async function callAgent(
  apiBase: string,
  question: string,
  accessToken: string,
  timeoutMs = 150_000,
  profileId = 'team',
  parentSignal?: AbortSignal,
): Promise<AgentResponse> {
  // The caller token belongs to a real, active team/super account. Every
  // self-call is revalidated by the normal API authentication middleware.
  const internalHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = parentSignal ? AbortSignal.any([timeoutSignal, parentSignal]) : timeoutSignal;

  // 1. Create an eval session
  const sessionRes = await fetch(`${apiBase}/api/sessions`, {
    method: 'POST',
    headers: internalHeaders,
    body: JSON.stringify({ title: `[eval] ${question.slice(0, 60)}`, profile_id: profileId }),
    signal: requestSignal,
  });
  if (!sessionRes.ok) {
    throw new Error(`Failed to create eval session: ${sessionRes.status} ${await sessionRes.text().catch(() => '')}`);
  }
  const session = (await sessionRes.json()) as { id: string };

  // `/api/chat` deliberately detaches generation from the HTTP connection so
  // browser refreshes do not kill a user turn. Eval is different: its durable
  // driver owns the child turn and cancel/timeout must actively stop it. Start
  // a fresh, short-lived control request when the read signal aborts; never
  // reuse the already-aborted signal.
  let stopPromise: Promise<void> | null = null;
  const stopDetachedChat = () => {
    stopPromise ??= fetch(`${apiBase}/api/chat/runs/${encodeURIComponent(session.id)}/stop`, {
      method: 'POST',
      headers: internalHeaders,
      signal: AbortSignal.timeout(5_000),
    })
      .then(async (response) => {
        if (!response.ok && response.status !== 404) {
          throw new Error(`Chat stop API ${response.status}: ${await response.text().catch(() => '')}`);
        }
      })
      .catch((error) => {
        logger.warn(`[Eval] failed to stop detached Chat ${session.id}: ${toErrorMessage(error)}`);
      });
  };
  requestSignal.addEventListener('abort', stopDetachedChat, { once: true });

  try {
    // Mark as Eval before Chat can select the isolated budget/tool policy.
    // This provenance step is fail-closed: falling back to an ordinary super
    // conversation would silently restore mutation tools and the standard
    // budget pool, making a supposedly replay-safe Eval unsafe.
    const markEvalResponse = await fetch(`${apiBase}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: internalHeaders,
      body: JSON.stringify({ status: 'eval' }),
      signal: requestSignal,
    });
    if (!markEvalResponse.ok) {
      throw new Error(
        `Failed to mark Eval session: ${markEvalResponse.status} ${await markEvalResponse.text().catch(() => '')}`,
      );
    }

    // 2. Call chat API with streaming and collect response
    const t0 = Date.now();
    const chatRes = await fetch(`${apiBase}/api/chat`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({
        session_id: session.id,
        messages: [{ role: 'user', content: question }],
      }),
      signal: requestSignal,
    });

    if (!chatRes.ok) {
      throw new Error(`Chat API ${chatRes.status}: ${await chatRes.text().catch(() => '')}`);
    }

    // Parse NDJSON stream
    const reader = chatRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let ttfbMs = 0;
    let gotFirstText = false;
    let gotFinish = false;
    let streamError: string | null = null;
    const references: AgentReference[] = [];

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        switch (event.type) {
          case 'text-delta':
            if (!gotFirstText) {
              ttfbMs = Date.now() - t0;
              gotFirstText = true;
            }
            fullText += event.text;
            break;
          case 'finish':
            gotFinish = true;
            break;
          case 'error':
            streamError = String(event.error || 'Unknown agent error');
            break;
          case 'tool-result':
            // A knowledge_query `get` result is a document the agent actually read.
            if (
              event.toolName === 'knowledge_query' &&
              typeof event.output?.title === 'string' &&
              !event.output?.error &&
              (event.output?.doc_id || event.output?.slug)
            ) {
              references.push({
                slug: (event.output.slug as string) || (event.output.doc_id as string) || '',
                title: event.output.title as string,
                category: event.output.folder as string | undefined,
              });
            }
            break;
        }
      } catch {
        /* skip malformed JSON lines */
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        processLine(line);
      }
    }

    // Flush remaining buffer
    buffer += decoder.decode();
    if (buffer.trim()) {
      processLine(buffer);
    }

    if (streamError) {
      throw new Error(`Agent stream error: ${streamError}`);
    }

    // Fallback: try reading session's persisted assistant message
    if (!fullText.trim()) {
      logger.info(`[Eval] ⚠️ No text-delta received for "${question.slice(0, 50)}...", trying session fallback...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (requestSignal.aborted) throw requestSignal.reason;
      try {
        const sessRes = await fetch(`${apiBase}/api/sessions/${session.id}`, {
          headers: internalHeaders,
          signal: requestSignal,
        });
        if (sessRes.ok) {
          const data = (await sessRes.json()) as {
            messages?: Array<{ role: string; content: string }>;
          };
          const assistantMsg = data.messages?.filter((m) => m.role === 'assistant').pop();
          if (assistantMsg?.content) {
            fullText = assistantMsg.content;
            logger.info(`[Eval] ✅ Recovered answer from session (${fullText.length} chars)`);
          }
        }
      } catch (e) {
        logger.warn(`[Eval] ⚠️ Session fallback failed: ${e}`);
      }
    }

    if (!fullText.trim() && !gotFinish) {
      throw new Error('Agent stream ended without finish event and produced no answer');
    }

    const durationMs = Date.now() - t0;
    if (!gotFirstText) ttfbMs = durationMs;
    return { answer: fullText, references, durationMs, ttfbMs, sessionId: session.id };
  } finally {
    requestSignal.removeEventListener('abort', stopDetachedChat);
    if (requestSignal.aborted) {
      stopDetachedChat();
      await stopPromise;
    }
  }
}

// ─── Active Run Tracking (for cancellation) ─────────────

const activeRuns = new Map<string, AbortController>();

/** Cancel an active eval run by ID. Returns true if the run was found and aborted. */
export function cancelActiveRun(runId: string): boolean {
  const controller = activeRuns.get(runId);
  if (controller) {
    controller.abort();
    return true;
  }
  return false;
}

// ─── Run Engine ──────────────────────────────────────────

export interface RunOptions {
  /** Access token for the real team/super account that initiated the run. */
  accessToken: string;
  /** Internal owner whose hard budget the agent and judge calls consume. */
  userId: string;
  name?: string;
  profileId?: string;
  concurrency?: number;
  apiBase?: string;
  agentTimeoutMs?: number;
  datasetIds?: number[];
  /** Called as soon as the run record exists — lets callers return the run id
   *  without polling listRuns (the old sleep-200ms + find('running') race). */
  onRunCreated?: (run: EvalRun) => void;
  onProgress?: (info: {
    completed: number;
    total: number;
    datasetId: number;
    question: string;
    score?: number;
    error?: string;
  }) => void;
}

export async function executeRun(evalRepo: EvalService, opts: RunOptions): Promise<EvalRun> {
  const {
    accessToken,
    name,
    profileId: requestedProfileId = 'team',
    concurrency = 5,
    apiBase = `http://localhost:${process.env.API_PORT ?? '3000'}`,
    agentTimeoutMs = 150_000,
    onProgress,
  } = opts;
  const profileId = await pinProfileVersion(requestedProfileId);

  const judgeProfile = BATCH_EVAL_JUDGE_PROFILE;
  let datasets = await evalRepo.listDatasets({ enabled: true });

  // Filter to specific dataset IDs if provided
  if (opts.datasetIds && opts.datasetIds.length > 0) {
    const idSet = new Set(opts.datasetIds);
    datasets = datasets.filter((d) => idSet.has(d.id));
  }

  if (datasets.length === 0) {
    throw new Error('No enabled datasets found');
  }

  const targetProfile = await resolveProfileAsync(profileId);
  const model = targetProfile.model.id ?? targetProfile.model.model ?? profileId;

  const run = await evalRepo.createRun({
    name,
    total: datasets.length,
    model,
    profileId,
    config: {
      concurrency,
      apiBase,
      profileId,
      judgeModel: judgeProfile.model.model,
      weights: WEIGHTS,
    },
  });
  opts.onRunCreated?.(run);

  // Register abort controller for this run
  const abortController = new AbortController();
  activeRuns.set(run.id, abortController);

  // Create result placeholders
  const resultIds = new Map<number, number>();
  for (const ds of datasets) {
    const resultId = await evalRepo.createResult({ run_id: run.id, dataset_id: ds.id });
    resultIds.set(ds.id, resultId);
  }

  let completedCount = 0;

  try {
    // Run with concurrency control (with abort signal)
    await runWithConcurrency(
      datasets,
      concurrency,
      async (ds) => {
        // Skip if cancelled
        if (abortController.signal.aborted) return;

        const resultId = resultIds.get(ds.id)!;
        const groundTruth: string[] = JSON.parse(ds.ground_truth);

        try {
          // 1. Call agent
          const agentRes = await callAgent(apiBase, ds.question, accessToken, agentTimeoutMs, profileId);

          // Check abort again after long agent call
          if (abortController.signal.aborted) return;

          // 2. LLM-as-Judge scoring
          const judgeScores = await judgeAnswer(
            ds.question,
            groundTruth,
            agentRes.answer,
            agentRes.references.map((r) => r.title),
            ds.is_negative === 1,
            opts.userId,
          );

          // 3. Speed score
          const speedResult = computeSpeedScore({
            ttfbMs: agentRes.ttfbMs,
            totalMs: agentRes.durationMs,
            answerLength: agentRes.answer.length,
          });

          // 4. Final score
          const finalScore = computeFinalScore({
            accuracy: judgeScores.accuracy.score,
            completeness: judgeScores.completeness.score,
            relevance: judgeScores.relevance.score,
            speed: speedResult.score,
          });

          // 5. Save result
          await evalRepo.updateResult(resultId, {
            answer: agentRes.answer,
            references_used: agentRes.references,
            duration_ms: agentRes.durationMs,
            ttfb_ms: agentRes.ttfbMs,
            answer_length: agentRes.answer.length,
            session_id: agentRes.sessionId,
            score_accuracy: judgeScores.accuracy.score,
            score_completeness: judgeScores.completeness.score,
            score_relevance: judgeScores.relevance.score,
            score_speed: speedResult.score,
            score_final: finalScore,
            judge_reasoning: {
              accuracy: judgeScores.accuracy,
              completeness: judgeScores.completeness,
              relevance: judgeScores.relevance,
              speed: {
                score: speedResult.score,
                ttfbScore: speedResult.ttfbScore,
                throughputScore: speedResult.throughputScore,
                reason: `TTFB ${agentRes.ttfbMs}ms, 总耗时 ${agentRes.durationMs}ms, 输出 ${agentRes.answer.length} 字符, 吞吐 ${speedResult.throughputCps} chars/s`,
              },
            },
            status: 'completed',
          });

          completedCount++;
          await evalRepo.updateRunProgress(run.id, completedCount);

          onProgress?.({
            completed: completedCount,
            total: datasets.length,
            datasetId: ds.id,
            question: ds.question,
            score: finalScore,
          });
        } catch (err) {
          // Don't log errors for aborted runs
          if (abortController.signal.aborted) return;

          const errMsg = toErrorMessage(err);
          await evalRepo.updateResult(resultId, {
            status: 'error',
            error: errMsg,
          });

          completedCount++;
          await evalRepo.updateRunProgress(run.id, completedCount);

          onProgress?.({
            completed: completedCount,
            total: datasets.length,
            datasetId: ds.id,
            question: ds.question,
            error: errMsg,
          });
        }
      },
      abortController.signal,
    );

    // Check if cancelled
    if (abortController.signal.aborted) {
      logger.info(`[Eval] Run ${run.id} was cancelled.`);
      await evalRepo.cancelRun(run.id);
      return (await evalRepo.getRun(run.id))!;
    }

    // Finalize
    const finalRun = await evalRepo.finalizeRun(run.id);
    return finalRun!;
  } finally {
    activeRuns.delete(run.id);
  }
}
