/**
 * Shared headless agent runner.
 *
 * The single "run an agent turn to completion in a session" loop, factored out so
 * BOTH the scheduled-task executor and the spawn_session tool drive the agent the
 * same way — build model → generateText (bounded by maxSteps) → extract pipeline +
 * references → persist the assistant message. No scheduled-task specifics live
 * here, so it is reusable by any caller that already has a session + a prompt.
 *
 * `generate` and `model` are injectable seams so callers (and tests) can stub the
 * LLM without touching the real provider.
 */

import { randomUUID } from 'node:crypto';
import { generateText, stepCountIs } from 'ai';
import {
  createModelFromConfig,
  buildProviderOptions,
  summarizeOutput,
  CHAT_STREAM_TIMEOUT,
} from '@greenhouse/agent-core';
import type { ModelConfig, ProviderAttemptHook } from '@greenhouse/agent-core';
import { getDb, type DatabaseProvider } from '@greenhouse/db';
import type { PipelineStep, Reference } from '@greenhouse/types/session';
import { logger } from '@greenhouse/utils/logger';
import type { ToolRegistry } from '../agent.js';
import { instrumentRuntimeTools, type RuntimeToolEvidenceScope } from '../runtime/tool-evidence.js';
import {
  createProviderAttemptBudgetHook,
  estimateAgentLoopTokens,
  reserveUserTokenBudget,
  settleAndRecordBudgetedUsage,
} from '../llm/usage-budget.js';

// ─── Generate seam ───────────────────────────────────────
//
// The seam takes the ModelConfig (not a built model) so the default impl owns
// provider construction — a stubbed generate (tests) never touches a real LLM.

export interface AgentGenerateArgs {
  modelConfig: ModelConfig;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools?: ToolRegistry;
  maxSteps: number;
  toolChoice?: 'auto' | 'none' | 'required';
  providerOptions?: unknown;
  /** Aborts the underlying LLM call (timeout / parent-turn cancellation). */
  abortSignal?: AbortSignal;
  providerAttemptHook?: ProviderAttemptHook;
}

export interface AgentGenerateResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number };
  steps?: any[];
}

export type AgentGenerate = (args: AgentGenerateArgs) => Promise<AgentGenerateResult>;

export class SessionTranscriptChangedError extends Error {
  constructor(message = 'Session transcript changed while the agent turn was running') {
    super(message);
    this.name = 'SessionTranscriptChangedError';
  }
}

/** Real generateText-backed implementation (the production default). */
const defaultGenerate: AgentGenerate = async (args) => {
  const model = await createModelFromConfig(
    args.modelConfig,
    args.providerAttemptHook ? { onProviderAttempt: args.providerAttemptHook } : {},
  );
  const providerOptions = args.providerOptions ?? buildProviderOptions(args.modelConfig);
  const result = await generateText({
    model,
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    stopWhen: stepCountIs(args.maxSteps),
    // Same SDK-layer bound as the streaming chat path — without it a headless
    // run (notably the scheduler, which passes no abortSignal) has no time limit.
    timeout: CHAT_STREAM_TIMEOUT,
    toolChoice: (args.toolChoice ?? 'auto') as any,
    // Force a final text answer on the last step so the run never ends mid-tool-call.
    prepareStep: ({ stepNumber }: { stepNumber: number }) =>
      stepNumber === args.maxSteps - 1 ? { toolChoice: 'none' as const } : {},
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  } as any);
  // totalUsage spans every step of the loop; `usage` is only the final step.
  return { text: result.text, usage: (result.totalUsage ?? result.usage) as any, steps: result.steps as any };
};

// ─── Runner ──────────────────────────────────────────────

export interface RunAgentInSessionArgs {
  /** Defaults to the global getDb() singleton; injectable for tests. */
  db?: DatabaseProvider;
  sessionId: string;
  system: string;
  /** The user turn to send. The caller is responsible for persisting it first. */
  prompt: string;
  modelConfig: ModelConfig;
  tools?: ToolRegistry;
  maxSteps: number;
  toolChoice?: 'auto' | 'none' | 'required';
  /** Defaults to buildProviderOptions(modelConfig). */
  providerOptions?: unknown;
  /** When false, the assistant message is NOT persisted (caller handles it). Default true. */
  persist?: boolean;
  /** Aborts the underlying LLM call (forwarded to the generate seam). */
  abortSignal?: AbortSignal;
  /** Test/override seam — defaults to the real generateText-backed implementation. */
  generate?: AgentGenerate;
  /**
   * Durable ToolCall attribution for Runtime-driven headless execution. The
   * shared runner wraps every tool at its actual `execute` boundary before
   * handing the registry to either the production generator or a test seam.
   */
  runtimeToolEvidence?: Omit<RuntimeToolEvidenceScope, 'db'>;
  /**
   * llm_usage attribution — REQUIRED so no headless caller can silently skip
   * usage accounting (and the owner's monthly quota) again. `userId` is the
   * account whose quota this run burns; `caller` labels the surface
   * ('scheduled-task' | 'spawn_session' | 'workflow' | 'workflow-review' | …).
   */
  usageContext: { profileId: string; userId: string; caller: string };
}

export interface RunAgentResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  durationMs: number;
  pipeline: PipelineStep[];
  references: Reference[];
  /**
   * Full-fidelity tool evidence for Runtime/audit consumers. Unlike `pipeline`,
   * this is never summarized or truncated and is not used as UI chrome.
   */
  toolEvidence: Array<{
    toolCallId: string | null;
    toolName: string;
    input: unknown;
    output: unknown;
    hasResult: boolean;
  }>;
  /** False only when persistence is disabled; transcript conflicts throw. */
  persisted: boolean;
}

/**
 * Run one agent turn inside an existing session and (by default) persist the
 * resulting assistant message with its pipeline + references.
 */
export async function runAgentInSession(args: RunAgentInSessionArgs): Promise<RunAgentResult> {
  const startTime = Date.now();
  const db = args.db ?? getDb();
  const generate = args.generate ?? defaultGenerate;
  const shouldPersist = args.persist !== false;
  let expectedTail: { id: string; content: string } | undefined;

  if (shouldPersist) {
    const currentTail = await db.sessions.getLatestMessage(args.sessionId);
    if (!currentTail || currentTail.role !== 'user' || currentTail.content !== args.prompt) {
      throw new SessionTranscriptChangedError('Session transcript changed before agent generation');
    }
    expectedTail = {
      id: currentTail.id,
      content: currentTail.content,
    };
  }

  const providerAttemptHook = createProviderAttemptBudgetHook({
    db,
    userId: args.usageContext.userId,
    caller: args.usageContext.caller,
    profileId: args.usageContext.profileId,
    sessionId: args.sessionId,
    runId: args.sessionId,
    metadata: { max_steps: args.maxSteps },
  });

  // Production models are metered at each concrete V3 attempt. An injected
  // generator does not cross that wrapper, so retain one conservative lease
  // around the explicit test/override seam.
  let injectedBudget: Awaited<ReturnType<typeof reserveUserTokenBudget>> | null = null;
  let injectedEstimate = 0;
  if (args.generate) {
    injectedEstimate = estimateAgentLoopTokens({
      system: args.system,
      messages: [{ role: 'user', content: args.prompt }],
      maxSteps: args.maxSteps,
      maxOutputTokens: args.modelConfig.options?.max_tokens,
    });
    injectedBudget = await reserveUserTokenBudget({
      db,
      userId: args.usageContext.userId,
      caller: args.usageContext.caller,
      estimatedTokens: injectedEstimate,
      modelId: args.modelConfig.id ?? args.modelConfig.model,
      providerId: args.modelConfig.provider,
      runId: args.sessionId,
      idempotencyKey: `${args.usageContext.caller}:${args.sessionId}:${randomUUID()}`,
      metadata: { session_id: args.sessionId, profile_id: args.usageContext.profileId, max_steps: args.maxSteps },
    });
    injectedBudget.markProviderIoStarted();
  }
  const executionTools = args.runtimeToolEvidence
    ? instrumentRuntimeTools(args.tools, { db, ...args.runtimeToolEvidence })
    : args.tools;
  const result: AgentGenerateResult = await generate({
    modelConfig: args.modelConfig,
    system: args.system,
    messages: [{ role: 'user', content: args.prompt }],
    tools: executionTools,
    maxSteps: args.maxSteps,
    toolChoice: args.toolChoice,
    providerOptions: args.providerOptions,
    abortSignal: args.abortSignal,
    providerAttemptHook,
  });

  const { pipeline, references } = extractPipelineAndReferences(result.steps ?? []);
  const toolEvidence = extractExactToolEvidence(result.steps ?? []);
  const durationMs = Date.now() - startTime;
  let persisted = false;

  if (injectedBudget) {
    await settleAgentUsage(db, args, result, durationMs, injectedBudget, injectedEstimate);
  }

  if (shouldPersist && expectedTail) {
    const appended = await db.sessions.appendAssistantIfTail(args.sessionId, expectedTail, {
      session_id: args.sessionId,
      role: 'assistant',
      content: result.text,
      references,
      pipeline,
      input_tokens: result.usage?.inputTokens,
      output_tokens: result.usage?.outputTokens,
      cached_tokens: result.usage?.cachedInputTokens,
      reasoning_tokens: result.usage?.reasoningTokens,
      duration_ms: durationMs,
    });
    persisted = appended.ok;
    if (!appended.ok) {
      logger.warn('[agent-runtime] skipped stale assistant persistence after transcript changed', {
        sessionId: args.sessionId,
        expectedTailMessageId: expectedTail.id,
        reason: appended.reason,
      });
      throw new SessionTranscriptChangedError();
    }
  }

  return { text: result.text, usage: result.usage, durationMs, pipeline, references, toolEvidence, persisted };
}

/**
 * Fire-and-forget llm_usage row for a headless agent turn. Accounting must
 * never fail (or slow) the run itself, so errors only warn — including partial
 * test doubles that stub `db` without a usage service.
 */
async function settleAgentUsage(
  db: DatabaseProvider,
  args: RunAgentInSessionArgs,
  result: AgentGenerateResult,
  durationMs: number,
  budget: Awaited<ReturnType<typeof reserveUserTokenBudget>>,
  estimatedTokens: number,
): Promise<void> {
  const usage = result.usage;
  // AI SDK normally supplies usage. A provider adapter that omits it is settled
  // at the conservative preflight estimate rather than turning a successful
  // provider call into free usage.
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage ? (usage.outputTokens ?? 0) : estimatedTokens;
  const warn = (err: unknown) =>
    logger.warn('[agent-runtime] failed to settle budgeted llm usage', {
      sessionId: args.sessionId,
      caller: args.usageContext.caller,
      error: String(err),
    });
  try {
    await settleAndRecordBudgetedUsage(db, budget, {
      profile_id: args.usageContext.profileId,
      caller: args.usageContext.caller,
      session_id: args.sessionId,
      user_id: args.usageContext.userId,
      // Registry id (flash/pro/…) when the config came from the catalog —
      // same convention as the chat path's modelId.
      model: args.modelConfig.id ?? args.modelConfig.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_tokens: usage?.cachedInputTokens ?? 0,
      reasoning_tokens: usage?.reasoningTokens ?? 0,
      duration_ms: durationMs,
    });
  } catch (err) {
    warn(err);
  }
}

// ─── Pipeline + reference extraction ─────────────────────

/** Build pipeline steps + dedup references from the model's tool-call steps. */
export function extractPipelineAndReferences(steps: any[]): {
  pipeline: PipelineStep[];
  references: Reference[];
} {
  const pipeline: PipelineStep[] = [];
  const referencesMap = new Map<string, Reference>();

  for (const step of steps) {
    if (!step?.toolCalls) continue;
    for (const tc of step.toolCalls) {
      const toolName = (tc as any).toolName ?? 'unknown';
      // AI SDK v6 names these `input`/`output` (v4 used `args`/`result`); the v4
      // names are kept as fallbacks so a version bump can't silently blank these.
      const toolArgs = (tc as any).input ?? (tc as any).args ?? {};
      const toolResult = step.toolResults?.find((tr: any) => tr.toolCallId === (tc as any).toolCallId);
      const toolOutput = toolResult ? ((toolResult as any).output ?? (toolResult as any).result ?? {}) : {};

      pipeline.push({
        step: pipeline.length + 1,
        tool: toolName,
        input: summarizeInput(toolName, toolArgs),
        output: summarizeOutput(toolName, toolOutput),
        duration_ms: 0,
      });

      // Extract references from knowledge documents actually read.
      if (
        toolName === 'knowledge_query' &&
        typeof toolOutput?.doc_id === 'string' &&
        typeof toolOutput?.title === 'string' &&
        !toolOutput?.error &&
        !referencesMap.has(toolOutput.doc_id)
      ) {
        referencesMap.set(toolOutput.doc_id, {
          slug: toolOutput.doc_id,
          title: toolOutput.title || toolOutput.doc_id,
          type: 'kb_doc',
          ...(typeof toolOutput.url === 'string' ? { url: toolOutput.url } : {}),
          category: toolOutput.folder,
        });
      }
    }
  }

  return { pipeline, references: [...referencesMap.values()] };
}

/** Preserve exact tool parameters/results for permanent Runtime evidence. */
export function extractExactToolEvidence(steps: any[]): RunAgentResult['toolEvidence'] {
  const evidence: RunAgentResult['toolEvidence'] = [];
  for (const step of steps) {
    for (const call of step?.toolCalls ?? []) {
      const toolCallId =
        typeof call?.toolCallId === 'string' ? call.toolCallId : typeof call?.id === 'string' ? call.id : null;
      const result = (step?.toolResults ?? []).find((candidate: any) => {
        const candidateId = candidate?.toolCallId ?? candidate?.id;
        return toolCallId !== null && candidateId === toolCallId;
      });
      evidence.push({
        toolCallId,
        toolName: typeof call?.toolName === 'string' ? call.toolName : 'unknown',
        input: call?.input ?? call?.args ?? {},
        output: result ? (result.output ?? result.result ?? null) : null,
        hasResult: Boolean(result),
      });
    }
  }
  return evidence;
}

/** Summarize tool input for pipeline recording. */
function summarizeInput(toolName: string, input: Record<string, unknown>): unknown {
  if (!input || typeof input !== 'object') return {};
  switch (toolName) {
    case 'knowledge_query':
      return input.action === 'get' || input.action === 'versions'
        ? { action: input.action ?? '', scope: input.scope ?? '', doc_id: input.doc_id ?? '' }
        : {
            action: input.action ?? '',
            scope: input.scope ?? '',
            query: input.query ?? '',
            ...(input.folder ? { folder: input.folder } : {}),
          };
    default:
      return input;
  }
}

// Tool output summarization is shared with the streaming chat path
// (`summarizeOutput` from @greenhouse/agent-core) so a child/scheduled session's
// persisted pipeline carries the SAME full output the chat UI renders from —
// otherwise non-whitelisted tools (eval/update_page/generate_image/spawn_session/…)
// would collapse to `{ keys: [...] }` and show up blank when the session is opened.
