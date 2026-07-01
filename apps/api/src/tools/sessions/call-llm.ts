/**
 * Call LLM tool — a one-shot, tool-less LLM sub-call from within a session.
 *
 * Lightweight counterpart to spawn_session: no child session, no agent loop, no
 * tools — just a single model call whose full input/output is recorded to the
 * `llm_calls` audit table (so it is retrospectable without being reloaded into
 * the calling session's context). The model can issue several call_llm calls in
 * one turn to fan out in parallel.
 */

import { generateText, tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getModelEntry, createModelFromConfig, buildProviderOptions } from '@greenhouse/agent-core';
import type { ModelConfig } from '@greenhouse/agent-core';
import type { DatabaseProvider } from '@greenhouse/db';
import { resolveProfileAsync } from '../../profile.js';
import { defineTool, type ToolMeta } from '../define.js';

const callLlmSchema = z.object({
  prompt: z.string().min(1).describe('The full instruction + content for this one-shot LLM call.'),
  system: z.string().optional().describe('Optional system instruction scoping this call.'),
  model: z
    .string()
    .optional()
    .describe('Optional registry model id (e.g. a cheaper model). Defaults to the current profile model.'),
});

type CallLlmInput = z.infer<typeof callLlmSchema>;

/** A one-shot LLM call must be quick; this guards against a hung provider. */
const CALL_LLM_TIMEOUT_MS = 120_000; // 2 min

/** Minimal generate seam so tests can stub the LLM without a real provider. */
export type OneShotGenerate = (args: {
  modelConfig: ModelConfig;
  system?: string;
  prompt: string;
  abortSignal?: AbortSignal;
}) => Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number } }>;

const defaultGenerate: OneShotGenerate = async ({ modelConfig, system, prompt, abortSignal }) => {
  const model = await createModelFromConfig(modelConfig);
  const providerOptions = buildProviderOptions(modelConfig);
  const result = await generateText({
    model,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: prompt }],
    ...(abortSignal ? { abortSignal } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  } as any);
  return { text: result.text, usage: result.usage as any };
};

export interface CallLlmContext {
  userId: string;
  /** The calling session — audit rows attach here. call_llm is session-scoped. */
  sessionId: string;
  profileId?: string | null;
  /** Test seam. */
  generate?: OneShotGenerate;
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'call_llm',
  name: 'Call LLM',
  brief: 'One-shot, tool-less LLM sub-call in an isolated context (optional cheaper model)',
  description: `Make a single, isolated LLM call and get its text back. The sub-call does NOT see this conversation — pass it everything it needs in \`prompt\`.

Use it to summarize / classify / extract / rewrite / transform a chunk of content WITHOUT loading that content (or the full result) into your own context, or to route bulk/simple work to a cheaper \`model\`. Call it several times in one turn to fan the work out in parallel.

This is one round with no tools — for any task that needs tools or multiple steps, use spawn_session instead. Every call's full input and output is recorded for later retrospection.`,
  category: 'team',
  is_global: true,
  icon: 'Sparkles',
  group: 'sessions',
};

export function createCallLlmTool(db: DatabaseProvider, ctx: CallLlmContext) {
  return tool({
    description: meta.description,
    inputSchema: callLlmSchema,
    execute: async (input: CallLlmInput, { abortSignal: parentSignal }: { abortSignal?: AbortSignal } = {}) => {
      const startTime = Date.now();

      // Resolve model: an explicit valid registry id overrides the profile model.
      const profile = await resolveProfileAsync(ctx.profileId);
      let modelConfig = profile.model;
      if (input.model) {
        if (!getModelEntry(input.model)) {
          return { error: `Unknown model id: "${input.model}"` };
        }
        modelConfig = { ...profile.model, id: input.model, model: input.model };
      }
      const modelLabel = modelConfig.id ?? modelConfig.model;

      // Bound the call by a timeout (+ the parent turn's cancel signal) so a hung
      // provider can't stall the calling turn.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALL_LLM_TIMEOUT_MS);
      const abortSignal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;

      try {
        const generate = ctx.generate ?? defaultGenerate;
        const result = await generate({ modelConfig, system: input.system, prompt: input.prompt, abortSignal });
        const durationMs = Date.now() - startTime;

        // Best-effort audit; never let a logging failure drop the answer.
        let llmCallId: string | undefined;
        try {
          const row = await db.llmCalls.record({
            session_id: ctx.sessionId,
            user_id: ctx.userId,
            model: modelLabel,
            system: input.system ?? null,
            input: input.prompt,
            output: result.text,
            status: 'ok',
            input_tokens: result.usage?.inputTokens ?? null,
            output_tokens: result.usage?.outputTokens ?? null,
            duration_ms: durationMs,
          });
          llmCallId = row.id;
        } catch {
          /* ignore audit write errors */
        }

        return {
          output: result.text,
          model: modelLabel,
          llm_call_id: llmCallId,
          usage: { input_tokens: result.usage?.inputTokens, output_tokens: result.usage?.outputTokens },
        };
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const message = controller.signal.aborted
          ? `call_llm timed out after ${Math.round(CALL_LLM_TIMEOUT_MS / 1000)}s`
          : toErrorMessage(err);
        try {
          await db.llmCalls.record({
            session_id: ctx.sessionId,
            user_id: ctx.userId,
            model: modelLabel,
            system: input.system ?? null,
            input: input.prompt,
            status: 'error',
            error: message,
            duration_ms: durationMs,
          });
        } catch {
          /* ignore */
        }
        return { error: message };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

export const callLlmTool = defineTool({
  meta,
  kind: 'lazy',
  requires: { user: 'internal', session: true },
  create: (ctx) =>
    createCallLlmTool(ctx.db, { userId: ctx.userId, sessionId: ctx.sessionId!, profileId: ctx.profileId ?? null }),
});
