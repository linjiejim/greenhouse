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

import { generateText, stepCountIs } from 'ai';
import { createModelFromConfig, buildProviderOptions, summarizeOutput } from '@greenhouse/agent-core';
import type { ModelConfig } from '@greenhouse/agent-core';
import { getDb, type DatabaseProvider } from '@greenhouse/db';
import type { PipelineStep, Reference } from '@greenhouse/types/session';
import type { ToolRegistry } from '../agent.js';

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
}

export interface AgentGenerateResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  steps?: any[];
}

export type AgentGenerate = (args: AgentGenerateArgs) => Promise<AgentGenerateResult>;

/** Real generateText-backed implementation (the production default). */
const defaultGenerate: AgentGenerate = async (args) => {
  const model = await createModelFromConfig(args.modelConfig);
  const providerOptions = args.providerOptions ?? buildProviderOptions(args.modelConfig);
  const result = await generateText({
    model,
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    stopWhen: stepCountIs(args.maxSteps),
    toolChoice: (args.toolChoice ?? 'auto') as any,
    // Force a final text answer on the last step so the run never ends mid-tool-call.
    prepareStep: ({ stepNumber }: { stepNumber: number }) =>
      stepNumber === args.maxSteps - 1 ? { toolChoice: 'none' as const } : {},
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  } as any);
  return { text: result.text, usage: result.usage as any, steps: result.steps as any };
};

// ─── Runner ──────────────────────────────────────────────

export interface RunAgentInSessionArgs {
  /** Defaults to the global getDb() singleton; injectable for tests. */
  db?: DatabaseProvider;
  sessionId: string;
  system: string;
  /** The user turn to send. The caller is responsible for persisting it first. */
  prompt: string;
  /**
   * Prior conversation turns to prepend before `prompt`, giving the run
   * multi-turn memory. Defaults to none (single-shot), so existing callers
   * (scheduler, spawn_session) are unchanged. Callers own the history + any cap.
   */
  priorMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
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
}

export interface RunAgentResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  durationMs: number;
  pipeline: PipelineStep[];
  references: Reference[];
}

/**
 * Run one agent turn inside an existing session and (by default) persist the
 * resulting assistant message with its pipeline + references.
 */
export async function runAgentInSession(args: RunAgentInSessionArgs): Promise<RunAgentResult> {
  const startTime = Date.now();
  const db = args.db ?? getDb();
  const generate = args.generate ?? defaultGenerate;

  const result = await generate({
    modelConfig: args.modelConfig,
    system: args.system,
    messages: [...(args.priorMessages ?? []), { role: 'user', content: args.prompt }],
    tools: args.tools,
    maxSteps: args.maxSteps,
    toolChoice: args.toolChoice,
    providerOptions: args.providerOptions,
    abortSignal: args.abortSignal,
  });

  const { pipeline, references } = extractPipelineAndReferences(result.steps ?? []);
  const durationMs = Date.now() - startTime;

  if (args.persist !== false) {
    await db.sessions.addMessage({
      session_id: args.sessionId,
      role: 'assistant',
      content: result.text,
      references,
      pipeline,
      input_tokens: result.usage?.inputTokens,
      output_tokens: result.usage?.outputTokens,
      duration_ms: durationMs,
    });
    await db.sessions.touch(args.sessionId);
  }

  return { text: result.text, usage: result.usage, durationMs, pipeline, references };
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

      // Extract citations from knowledge-base docs actually read (action=get).
      // Knowledge search returns candidate lists; only a doc that was opened
      // becomes a citation, so we collect on the 'get' branch keyed by doc_id.
      const isKnowledgeTool = toolName === 'knowledge_query';
      if (
        isKnowledgeTool &&
        toolOutput?.action === 'get' &&
        toolOutput?.doc_id &&
        !referencesMap.has(toolOutput.doc_id)
      ) {
        referencesMap.set(toolOutput.doc_id, {
          slug: toolOutput.doc_id,
          doc_id: toolOutput.doc_id,
          title: toolOutput.title || toolOutput.doc_id,
          type: 'wiki',
          category: toolOutput.category,
        });
      }
    }
  }

  return { pipeline, references: [...referencesMap.values()] };
}

/** Summarize tool input for pipeline recording. */
function summarizeInput(toolName: string, input: Record<string, unknown>): unknown {
  if (!input || typeof input !== 'object') return {};
  switch (toolName) {
    case 'knowledge_query':
      return input.action === 'get'
        ? { action: input.action ?? '', doc_id: input.doc_id ?? '' }
        : { action: input.action ?? '', query: input.query ?? '' };
    default:
      return input;
  }
}

// Tool output summarization is shared with the streaming chat path
// (`summarizeOutput` from @greenhouse/agent-core) so a child/scheduled session's
// persisted pipeline carries the SAME full output the chat UI renders from —
// otherwise non-whitelisted tools (update_page/generate_image/spawn_session/…)
// would collapse to `{ keys: [...] }` and show up blank when the session is opened.
