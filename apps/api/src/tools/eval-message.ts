/**
 * eval_message tool — evaluate a chat message's answer quality.
 *
 * Wraps judgeChatAnswer so an authorized Assistant session can evaluate any
 * assistant message via tool call. Type-aware KB-strictness, a pass/fail/pending
 * verdict, a structured consistency breakdown, and an explicit safety axis.
 *
 * Uses a dedicated low-temperature model call (temperature=0.1) for precise,
 * deterministic evaluation — independent of the agent's own model settings.
 */

import { tool } from 'ai';
import { defineTool, type ToolMeta } from './define.js';
import { z } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';
import { judgeChatAnswer, buildEvalContext, loadReferenceSources, retrieveKbForJudge } from '../chat/eval.js';

const evalMessageSchema = z.object({
  session_id: z.string().describe('The session ID containing the message to evaluate'),
  message_id: z.string().describe('The specific assistant message ID to evaluate'),
});

type EvalMessageInput = z.infer<typeof evalMessageSchema>;

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'eval_message',
  name: 'Eval Message',
  brief: 'Evaluate chat answer quality',
  description: `Evaluate a specific assistant message: classifies the question type, applies type-aware knowledge-base strictness (product/system questions must be strictly KB-grounded; general-knowledge questions may add outside knowledge), scores 4 dimensions (KB-consistency, citation correctness, boundary control, safety), gives a pass/fail/pending verdict, and breaks down what the answer added/rewrote/omitted vs the KB.
Give a brief summary — don't repeat data already shown in the eval card. The card already lists the verdict, scores, consistency breakdown and suggestions.`,
  category: 'admin',
  is_global: false,
  icon: 'FlaskConical',
  runtime_risk: 'r1',
  sort_order: 21,
  presentation: 'artifact', // renders as the EvalResultCard in the message body
};

export interface EvalMessageToolContext {
  /** Authenticated user whose permissions bound this tool instance. */
  userId: string;
  userRole: string;
  /**
   * The Agent session running this eval (NOT the session under test). Persisted as
   * `eval_session_id` so the chat UI can later restore this exact eval conversation
   * when the user re-opens an already-evaluated message. Undefined on surfaces
   * without a session (e.g. MCP/agent-proxy) — the eval still runs, just no restore link.
   */
  evalSessionId?: string | null;
}

export function createEvalMessageTool(db: DatabaseProvider, ctx: EvalMessageToolContext) {
  return tool({
    description: meta.description,
    inputSchema: evalMessageSchema,
    execute: async (input: EvalMessageInput) => {
      const { session_id, message_id } = input;
      const steps: string[] = [];

      // Step 1: Check the parent session before reading any messages. A tool
      // grant must never turn an opaque session UUID into a cross-user read.
      const session = await db.sessions.getById(session_id);
      if (!session || (ctx.userRole !== 'super' && ctx.userRole !== 'team')) {
        return { error: 'Session not found or unavailable', steps };
      }
      if (ctx.userRole !== 'super' && session.user_id !== ctx.userId) {
        const sharedSessionIds = await db.sessionShares.getSharedSessionIds(ctx.userId);
        if (!sharedSessionIds.includes(session_id)) {
          return { error: 'Session not found or unavailable', steps };
        }
      }

      // Step 2: Load messages only after the session access check.
      steps.push('Loading session messages...');
      const messages = await db.sessions.getMessages(session_id);
      const targetIdx = messages.findIndex((m) => m.id === message_id);
      const targetMsg = targetIdx >= 0 ? messages[targetIdx] : undefined;
      if (!targetMsg || targetMsg.role !== 'assistant') {
        return { error: 'Message not found or not an assistant message', steps };
      }

      // Step 3: Find the question + build context from the prior conversation
      steps.push('Finding the user question + context...');
      let question = '';
      for (let i = targetIdx - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          question = messages[i].content;
          break;
        }
      }
      if (!question) {
        return { error: 'No preceding user message found', steps };
      }

      const context = buildEvalContext(messages, targetIdx);

      // Step 4: Parse and fetch the AI's cited sources
      steps.push('Fetching referenced knowledge-base sources...');
      const { referenceSources, referencesChecked } = await loadReferenceSources(db, targetMsg.references_);
      steps.push(
        `Found ${referenceSources.length} reference source(s)` +
          (referenceSources.length === 0 ? ' — evaluating as a no-citation answer' : ''),
      );

      // Step 5: Independent KB retrieval — the judge searches the KB itself so it
      // can catch missed-retrieval and avoid asserting "KB has no X" blindly.
      steps.push('评测员独立检索知识库 (cross-check, catch 漏检索)...');
      const retrievedSources = await retrieveKbForJudge(db, question, {
        userId: ctx.userId,
        excludeSlugs: new Set(referenceSources.map((r) => r.slug)),
      });
      steps.push(`Retrieved ${retrievedSources.length} additional KB source(s) for cross-check`);

      // Step 6: Run judge (low-temperature, dedicated call). Zero references is a
      // valid case (model-direct or out-of-scope answers) — the judge handles it.
      steps.push('Running 问答评测 (一致性 / 引用正确性 / 边界控制 / 安全性 + 是否通过)...');
      const startTime = Date.now();
      const judgeResult = await judgeChatAnswer(
        question,
        targetMsg.content,
        referenceSources,
        ctx.userId,
        context,
        retrievedSources,
      );
      const durationMs = Date.now() - startTime;

      const verdictLabel = judgeResult.verdict === 'pass' ? '通过' : judgeResult.verdict === 'fail' ? '不通过' : '暂定';
      steps.push(
        `Evaluation complete in ${(durationMs / 1000).toFixed(1)}s — ${verdictLabel}` +
          (judgeResult.score_final != null ? ` (${judgeResult.score_final}/10)` : ''),
      );

      // Persist so the chat UI can detect "this message was evaluated" and restore
      // THIS eval conversation (eval_session_id) on a later click. Best-effort — a
      // persistence failure must never break the inline eval card the user just got.
      try {
        await db.chatEval.save({
          message_id,
          session_id,
          question,
          answer: targetMsg.content,
          score_final: judgeResult.score_final,
          verdict: judgeResult.verdict,
          classification: JSON.stringify(judgeResult.classification),
          dimensions: JSON.stringify(judgeResult.dimensions),
          consistency_detail: JSON.stringify(judgeResult.consistency_detail),
          citation_issues: JSON.stringify(judgeResult.citation_issues),
          suggestions: JSON.stringify(judgeResult.suggestions),
          judge_reasoning: JSON.stringify(judgeResult),
          references_checked: JSON.stringify(referencesChecked),
          duration_ms: durationMs,
          eval_session_id: ctx.evalSessionId ?? null,
        });
      } catch (err) {
        console.error('[eval_message] failed to persist eval result:', err);
      }

      return {
        verdict: judgeResult.verdict,
        verdict_reason: judgeResult.verdict_reason,
        score_final: judgeResult.score_final,
        classification: judgeResult.classification,
        dimensions: judgeResult.dimensions,
        consistency_detail: judgeResult.consistency_detail,
        citation_issues: judgeResult.citation_issues,
        suggestions: judgeResult.suggestions,
        references_checked: referencesChecked,
        retrieved_checked: retrievedSources.map((r) => ({
          slug: r.slug,
          title: r.title,
          category: r.category,
          relevance: r.relevance,
        })),
        question,
        answer_preview: targetMsg.content.slice(0, 300),
        duration_ms: durationMs,
        steps,
      };
    },
  });
}

// 'lazy' (not 'static') so it's built per-request in buildLazyServerTools with the
// running Agent sessionId → eval_session_id, enabling the chat UI's view/restore flow.
export const evalMessageTool = defineTool({ meta, kind: 'lazy' });
