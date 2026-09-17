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

import { createHash, randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { DatabaseProvider } from '@greenhouse/db';
import { resolveProfileAsync, type AgentProfile } from '../profiles/profile.js';
import { pinProfileIdForUser } from '../profiles/access.js';
import { sanitizeForPrompt } from '../security/security.js';
import type { AgentGenerate } from '../agent-runtime/run-agent.js';
import type { ToolRegistry } from '../agent.js';
import { connectionManager } from '../ws/connection-manager.js';
import {
  admitSubagentRuntimeRun,
  executeSubagentRuntimeRun,
  SUBAGENT_ASYNC_TIMEOUT_MS,
  SUBAGENT_SYNC_TIMEOUT_MS,
  subagentInlineWorkerId,
  waitForSubagentRuntimeRun,
} from '../runtime/subagent-driver.js';
import { runtimeDriverEnabled } from '../trusted-execution/kill-switches.js';
import { defineTool, type ToolMeta } from './define.js';

/** Max session lineage depth: a top-level session (0) → child (1) → grandchild (2). */
export const MAX_SPAWN_DEPTH = 2;
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
  userRole: 'team' | 'super';
  /** The spawning session. Required — spawn_session is session-scoped. */
  parentSessionId: string;
  parentProfileId?: string | null;
  /** Current durable execution envelope, when Chat/Automation/Workflow has one. */
  parentRuntimeRunId?: string | null;
  workspaceId?: string | null;
  agentInstanceId?: string;
  dialogueId?: string;
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
    runtimeRunId: string;
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

function durableSpawnIdentity(
  parentSessionId: string,
  toolCallId?: string,
): {
  childSessionId: string;
  seedMessageId: string;
} {
  const invocation = toolCallId?.trim() || randomUUID();
  const digest = createHash('sha256').update(`${parentSessionId}\0${invocation}`).digest('hex');
  return {
    childSessionId: `subagent-${digest.slice(0, 40)}`,
    seedMessageId: `subagent-seed-${digest.slice(40)}`,
  };
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
  runtime_risk: 'r1',
  sort_order: 32,
  presentation: 'artifact',
};

export function createSpawnSessionTool(db: DatabaseProvider, ctx: SpawnSessionContext) {
  return tool({
    description: meta.description,
    inputSchema: spawnSessionSchema,
    execute: async (
      input: SpawnSessionInput,
      { abortSignal: parentSignal, toolCallId }: { abortSignal?: AbortSignal; toolCallId?: string } = {},
    ) => {
      let createdChildSessionId: string | undefined;
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
        if (!runtimeDriverEnabled('subagent')) {
          return { error: 'Subagent Runtime is unavailable in this environment.' };
        }
        // Freeze custom Agent identity at creation; the durable driver resolves
        // this exact version again after claim and revalidates current access.
        let profileId: string;
        let profile: AgentProfile;
        try {
          profileId = await pinProfileIdForUser(
            { id: ctx.userId, role: ctx.userRole },
            input.profile_id ?? ctx.parentProfileId ?? undefined,
            db,
          );
          profile = await resolveProfileAsync(profileId, db);
        } catch (err) {
          return { error: `Invalid profile: ${toErrorMessage(err)}` };
        }

        // The tool-call identity is stable across an SDK replay. Deriving the
        // child/message ids from it makes the whole admission idempotent.
        const baseTitle = input.title?.trim() || truncate(input.prompt, 40);
        const title = `[spawn-session] ${baseTitle}`;
        const sanitizedPrompt = sanitizeForPrompt(input.prompt);
        const { childSessionId, seedMessageId } = durableSpawnIdentity(ctx.parentSessionId, toolCallId);

        // One transaction creates session + seed message + Run + Step. There is
        // no domain→Runtime crash window and no orphan child to reconcile.
        const maxSteps = input.max_steps ?? profile.max_steps ?? 12;
        const timeoutMs = mode === 'sync' ? SUBAGENT_SYNC_TIMEOUT_MS : SUBAGENT_ASYNC_TIMEOUT_MS;
        const envelope = await admitSubagentRuntimeRun(db, {
          owner_user_id: ctx.userId,
          initiated_by_user_id: ctx.userId,
          child_session_id: childSessionId,
          seed_message_id: seedMessageId,
          parent_session_id: ctx.parentSessionId,
          parent_runtime_run_id: ctx.parentRuntimeRunId ?? null,
          profile_id: profile.id,
          prompt: sanitizedPrompt,
          title,
          depth: childDepth,
          max_steps: maxSteps,
          mode,
          timeout_ms: timeoutMs,
          workspace_id: ctx.workspaceId ?? null,
          agent_instance_id: ctx.agentInstanceId,
          dialogue_id: ctx.dialogueId,
        });
        createdChildSessionId = childSessionId;

        // Notify only on the first committed admission; an idempotent retry
        // must not duplicate sidebar events.
        if (!envelope.idempotent) {
          try {
            connectionManager.sendToUser(ctx.userId, {
              type: 'session:created',
              sessionId: childSessionId,
              parentSessionId: ctx.parentSessionId,
              title,
            });
          } catch {
            /* WS notify is best-effort — never fail the spawn over it */
          }
        }

        if (mode === 'sync') {
          const workerId = subagentInlineWorkerId();
          const claimed = await db.runtime.claimExecution({
            run_id: envelope.run.id,
            step_id: envelope.step.id,
            worker_id: workerId,
            lease_ms: 30_000,
          });
          if (claimed) {
            await executeSubagentRuntimeRun(
              { db, run: claimed.run, workerId, leaseMs: 30_000 },
              {
                claimedStep: claimed.step,
                externalSignal: parentSignal,
                ...(ctx.generate ? { generate: ctx.generate } : {}),
                assembleTools: ({ childSessionId, profile: claimedProfile, depth, runtimeRunId }) =>
                  ctx.assembleChildTools({
                    childSessionId,
                    profile: claimedProfile,
                    depth,
                    runtimeRunId,
                  }),
              },
            );
          }
          const completed = await waitForSubagentRuntimeRun(
            db,
            envelope.run.id,
            timeoutMs + 5_000,
            parentSignal,
            ctx.userId,
          );
          const output = safeJsonParse(completed.output ?? '{}', {}) as {
            result?: {
              text?: string;
              usage?: { inputTokens?: number; outputTokens?: number };
            };
            error?: { message?: string };
          };
          if (completed.status !== 'succeeded') {
            return {
              status:
                completed.status === 'canceled'
                  ? 'cancelled'
                  : completed.error_code === 'subagent_transcript_changed'
                    ? 'conflict'
                    : 'error',
              child_session_id: childSessionId,
              runtime_run_id: completed.id,
              title,
              profile_id: profile.id,
              depth: childDepth,
              error: completed.error_message ?? output.error?.message ?? `Subagent ${completed.status}`,
            };
          }
          return {
            status: 'completed',
            child_session_id: childSessionId,
            runtime_run_id: completed.id,
            title,
            profile_id: profile.id,
            depth: childDepth,
            result: output.result?.text ?? '',
            usage: {
              input_tokens: output.result?.usage?.inputTokens,
              output_tokens: output.result?.usage?.outputTokens,
            },
          };
        }

        return {
          status: 'started',
          child_session_id: childSessionId,
          runtime_run_id: envelope.run.id,
          title,
          profile_id: profile.id,
          depth: childDepth,
          note: 'Running in the background. Read its result later with session_query (action="messages").',
        };
      } catch (err) {
        const message = toErrorMessage(err);
        // Once admission returns, the child always has a Runtime envelope. Any
        // error before that rolled the entire transaction back.
        if (createdChildSessionId) {
          return { status: 'error', child_session_id: createdChildSessionId, error: message };
        }
        return { error: message };
      }
    },
  });
}

export const spawnSessionTool = defineTool({ meta, kind: 'lazy' });
