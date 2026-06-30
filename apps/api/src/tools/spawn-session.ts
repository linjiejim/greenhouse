/**
 * Spawn Session tool — let a session delegate work to a child session that runs
 * the full agent loop (its own tool subset, multiple steps) to completion.
 *
 * - sync mode: wait for the child to finish and return its result.
 * - async mode: start it in the background and return the child session id; read
 *   the result later with session_query (requires confirm:true).
 *
 * The child is linked to its parent via sessions.parent_session_id, binds to the
 * SAME user (tools can never exceed the caller's permissions), and carries a
 * spawn_depth in metadata so recursion is bounded.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import type { DatabaseProvider } from '@greenhouse/db';
import { resolveProfileAsync, enrichSystemPrompt, type AgentProfile } from '../profile.js';
import { sanitizeForPrompt } from '../security.js';
import { runAgentInSession, type AgentGenerate, type RunAgentResult } from '../agent-runtime/run-agent.js';
import type { ToolRegistry } from '../agent.js';
import { connectionManager } from '../ws/connection-manager.js';
import { defineTool, type ToolMeta } from './define.js';

/** Max session lineage depth: a top-level session (0) → child (1) → grandchild (2). */
export const MAX_SPAWN_DEPTH = 2;
/** Cap on concurrently-running background (async) children per parent session. */
const MAX_ACTIVE_ASYNC_PER_PARENT = 5;
/**
 * Hard timeout for a SYNC child run — a safety net against a hung LLM call, not a
 * latency target (a real subtask the parent must synthesize can legitimately take
 * many minutes).
 */
const SYNC_TIMEOUT_MS = 600_000; // 10 min
/** Generous timeout for an ASYNC (background) child — only guards true hangs. */
const ASYNC_TIMEOUT_MS = 1_800_000; // 30 min

const activeAsyncByParent = new Map<string, number>();

const spawnSessionSchema = z.object({
  prompt: z.string().min(1).describe('The task/instructions for the spawned sub-session.'),
  title: z.string().optional().describe('Optional title for the spawned session.'),
  profile_id: z.string().optional().describe('Profile for the sub-session. Defaults to the current profile.'),
  mode: z
    .enum(['sync', 'async'])
    .default('sync')
    .describe(
      'sync = wait for the sub-session and return its result; async = run it in the background, return its id.',
    ),
  max_steps: z.number().int().positive().max(30).optional().describe('Max agent steps for the sub-session.'),
  confirm: z.boolean().optional().describe('Must be true for async (background) spawns.'),
});

type SpawnSessionInput = z.infer<typeof spawnSessionSchema>;

export interface SpawnSessionContext {
  userId: string;
  userRole: string;
  /** The spawning session. Required — spawn_session is session-scoped. */
  parentSessionId: string;
  parentProfileId?: string | null;
  /**
   * Builds the child's tool set for (childSessionId, profile, depth). Supplied by
   * the lazy-tool wiring so this file never imports the tool-resolution layer
   * (which imports this file). The closure is responsible for keeping the child's
   * tools ⊆ the caller's permissions and stripping spawn_session at the depth cap.
   */
  assembleChildTools: (args: {
    childSessionId: string;
    profile: AgentProfile;
    depth: number;
  }) => Promise<ToolRegistry> | ToolRegistry;
  /** Test seam — forwarded into the runner. */
  generate?: AgentGenerate;
}

/** Read the spawn_depth recorded in a session's metadata JSON (0 if absent). */
function readDepth(metadata: string): number {
  const meta = safeJsonParse(metadata, {}) as { spawn_depth?: number };
  const d = meta?.spawn_depth;
  return typeof d === 'number' && d >= 0 ? d : 0;
}

function truncate(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'spawn_session',
  name: 'Spawn Session',
  brief: 'Delegate a subtask to a child session that runs the full agent loop',
  description: `Delegate a self-contained subtask to a NEW child session that runs the full agent loop (its own tools, multiple steps) and reports back. Use this to parallelize or persistently work through a complex task: spawn several children for independent pieces, then combine their results.

- mode="sync" (default): waits for the child to finish and returns its final result. Best when you need the answer to continue.
- mode="async": starts the child in the background and returns its session id immediately (requires confirm:true). Read the result later with session_query (action="messages"). Best for long/independent work you don't need to block on.

The child sees ONLY the prompt you give it (not this conversation), binds to your account with tools that never exceed your own, and is linked back to this session. Spawn depth is bounded. For a single one-shot transform with no tools, prefer call_llm — it's much lighter.`,
  category: 'team',
  is_global: true,
  icon: 'GitBranch',
  sort_order: 32,
  presentation: 'artifact',
};

export function createSpawnSessionTool(db: DatabaseProvider, ctx: SpawnSessionContext) {
  return tool({
    description: meta.description,
    inputSchema: spawnSessionSchema,
    execute: async (input: SpawnSessionInput, { abortSignal: parentSignal }: { abortSignal?: AbortSignal } = {}) => {
      try {
        const parent = await db.sessions.getById(ctx.parentSessionId);
        if (!parent) return { error: 'Parent session not found' };

        const childDepth = readDepth(parent.metadata) + 1;
        if (childDepth > MAX_SPAWN_DEPTH) {
          return { error: `Max spawn depth (${MAX_SPAWN_DEPTH}) reached — cannot spawn a deeper sub-session.` };
        }

        const mode = input.mode ?? 'sync';
        if (mode === 'async' && input.confirm !== true) {
          return { error: 'Async (background) spawn requires confirm:true.' };
        }

        // Resolve the child profile (defaults to the parent's).
        const profileId = input.profile_id ?? ctx.parentProfileId ?? undefined;
        let profile: AgentProfile;
        try {
          profile = await resolveProfileAsync(profileId);
        } catch (err) {
          return { error: `Invalid profile: ${toErrorMessage(err)}` };
        }

        // Create the child session, linked + depth-stamped, with the (sanitized)
        // task as its first user message. The `[spawn-session]` prefix makes
        // children identifiable at a glance in the sidebar.
        const baseTitle = input.title?.trim() || truncate(input.prompt, 40);
        const title = `[spawn-session] ${baseTitle}`;
        const child = await db.sessions.create(
          title,
          profile.id,
          ctx.userId,
          undefined,
          'subagent',
          ctx.parentSessionId,
        );
        await db.sessions.update(child.id, {
          metadata: JSON.stringify({
            spawn_depth: childDepth,
            parent_session_id: ctx.parentSessionId,
            spawned_by: 'spawn_session',
          }),
        });
        const sanitizedPrompt = sanitizeForPrompt(input.prompt);
        await db.sessions.addMessage({ session_id: child.id, role: 'user', content: sanitizedPrompt });

        // Push to the owner's connected clients so the sidebar history refreshes
        // without a manual reload (covers both sync and async). Best-effort.
        try {
          connectionManager.sendToUser(ctx.userId, {
            type: 'session:created',
            sessionId: child.id,
            parentSessionId: ctx.parentSessionId,
            title,
          });
        } catch {
          /* WS notify is best-effort — never fail the spawn over it */
        }

        // Assemble the child's tools (depth-capped) and prepare the run. The child
        // gets the same step budget as a normal turn of its profile.
        const tools = await ctx.assembleChildTools({ childSessionId: child.id, profile, depth: childDepth });
        const maxSteps = input.max_steps ?? profile.max_steps ?? 12;
        const runArgs = {
          db,
          sessionId: child.id,
          system: enrichSystemPrompt(profile),
          prompt: sanitizedPrompt,
          modelConfig: profile.model,
          tools,
          maxSteps,
          toolChoice: profile.tool_choice,
          generate: ctx.generate,
        };

        // Run the child under a timeout (+ optional parent-cancel signal). NEVER
        // throws and NEVER leaves the child blank: on timeout/cancel/error it
        // persists a status message to the child so reopening it always shows why.
        const runChild = async (
          timeoutMs: number,
          parentSig?: AbortSignal,
        ): Promise<{ ok: true; result: RunAgentResult } | { ok: false; reason: string; message: string }> => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const abortSignal = parentSig ? AbortSignal.any([controller.signal, parentSig]) : controller.signal;
          try {
            const result = await runAgentInSession({ ...runArgs, abortSignal });
            return { ok: true, result };
          } catch (err) {
            const reason = controller.signal.aborted ? 'timeout' : parentSig?.aborted ? 'cancelled' : 'error';
            const message =
              reason === 'timeout'
                ? `⏱️ 子任务超时(${Math.round(timeoutMs / 1000)}s)已中止。如需更长时间，请改用 mode="async" 重试。`
                : reason === 'cancelled'
                  ? '⚠️ 父会话已取消，子任务一并中止。'
                  : `⚠️ 子任务执行失败: ${toErrorMessage(err)}`;
            if (reason === 'error') logger.error(`[spawn_session] child ${child.id} failed: ${toErrorMessage(err)}`);
            try {
              await db.sessions.addMessage({ session_id: child.id, role: 'assistant', content: message });
            } catch {
              /* ignore persistence errors during failure handling */
            }
            return { ok: false, reason, message };
          } finally {
            clearTimeout(timer);
          }
        };

        if (mode === 'sync') {
          const outcome = await runChild(SYNC_TIMEOUT_MS, parentSignal);
          if (!outcome.ok) {
            return {
              status: outcome.reason,
              child_session_id: child.id,
              title,
              profile_id: profile.id,
              depth: childDepth,
              error: outcome.message,
            };
          }
          return {
            status: 'completed',
            child_session_id: child.id,
            title,
            profile_id: profile.id,
            depth: childDepth,
            result: outcome.result.text,
            usage: {
              input_tokens: outcome.result.usage?.inputTokens,
              output_tokens: outcome.result.usage?.outputTokens,
            },
          };
        }

        // async: enforce the per-parent fan-out cap, then fire-and-forget. The
        // background run is intentionally NOT tied to the parent's signal (it
        // outlives the turn); it only stops on its own generous timeout.
        const active = activeAsyncByParent.get(ctx.parentSessionId) ?? 0;
        if (active >= MAX_ACTIVE_ASYNC_PER_PARENT) {
          return { error: `Too many concurrent background sub-sessions (max ${MAX_ACTIVE_ASYNC_PER_PARENT}).` };
        }
        activeAsyncByParent.set(ctx.parentSessionId, active + 1);
        void runChild(ASYNC_TIMEOUT_MS).finally(() => {
          const n = (activeAsyncByParent.get(ctx.parentSessionId) ?? 1) - 1;
          if (n <= 0) activeAsyncByParent.delete(ctx.parentSessionId);
          else activeAsyncByParent.set(ctx.parentSessionId, n);
        });

        return {
          status: 'started',
          child_session_id: child.id,
          title,
          profile_id: profile.id,
          depth: childDepth,
          note: 'Running in the background. Read its result later with session_query (action="messages").',
        };
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

export const spawnSessionTool = defineTool({ meta, kind: 'lazy' });
