/**
 * Agent runtime — shared tool resolution.
 *
 * Single source of truth for "which tools does this (user, profile) get, and how
 * are the per-request lazy server tools assembled". Used by both `/api/chat`
 * (session-authenticated) and `/api/agent/*` (API-key authenticated) so the two
 * never fork their permission logic.
 *
 * NOTE: the Desktop local-tool bridge is intentionally NOT handled here — it
 * carries route-specific UX (NDJSON bridge writers) and stays in the chat route.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import {
  resolveUserTools,
  selectTools,
  createFeatureRequestTool,
  createProjectManagerTool,
  createEmailManagerTool,
} from '../agent.js';
import type { ToolRegistry } from '../agent.js';
import { createSpawnSessionTool, MAX_SPAWN_DEPTH } from '../tools/spawn-session.js';
import { createCallLlmTool } from '../tools/call-llm.js';
import { createPersonalKnowledgeTool } from '../tools/personal-knowledge.js';
import { createSessionHistoryTool } from '../tools/session-history.js';
import { createProjectQueryTool } from '../tools/project-query.js';
import { createProjectMutationTool } from '../tools/project-mutation.js';
import { createSessionQueryTool } from '../tools/session-query.js';
import { createKnowledgeQueryTool } from '../tools/knowledge-query.js';
import { createKnowledgeMutationTool } from '../tools/knowledge-mutation.js';
import { createEmailQueryTool, createEmailMutationTool } from '../tools/email.js';
import type { AgentProfile } from '../profile.js';

/**
 * Tool IDs resolved per-request rather than from the base registry. The base
 * `selectTools()` pass must exclude these so it doesn't log misleading
 * "not found in registry" warnings.
 */
export const LAZY_TOOL_IDS = new Set([
  'feature_request',
  'project_manager',
  'email_manager',
  'email_query',
  'email_mutation',
  'personal_knowledge',
  'session_history',
  'project_query',
  'project_mutation',
  'session_query',
  'knowledge_query',
  'knowledge_mutation',
  'spawn_session',
  'call_llm',
]);

/**
 * Tool ids a child session may hold at a given lineage depth. spawn_session is
 * removed once the depth cap is reached, so a sub-session can never spawn an
 * endless chain of grandchildren. call_llm has no recursion vector and is kept.
 */
export function childSpawnToolIds(ids: string[], depth: number): string[] {
  return depth >= MAX_SPAWN_DEPTH ? ids.filter((t) => t !== 'spawn_session') : ids;
}

export interface ResolveEffectiveToolsArgs {
  userId: string | null;
  userRole: string;
  profile: AgentProfile;
  profileId: string;
}

export interface EffectiveToolsResult {
  /**
   * The tools effective for this request after profile intersection. This is
   * the ONLY tool set callers may expose to the model (tools[] and prompts
   * alike) — the user's full un-narrowed allow-set must not leave this module,
   * or internal tool names leak into public-profile sessions.
   */
  effectiveTools: string[];
}

/**
 * Resolve the effective tool set for a (user, profile) pair.
 *
 * - Custom and public profiles intersect their declared tools with the user's
 *   allowed set (a profile can only narrow, never widen, user permissions).
 * - Internal/admin profiles grant the full user-allowed set.
 * - Desktop-only profiles additionally grant their declared local tools, which
 *   are not part of the standard user allow-set.
 */
export async function resolveEffectiveTools(args: ResolveEffectiveToolsArgs): Promise<EffectiveToolsResult> {
  const { userId, userRole, profile, profileId } = args;

  const isCustomProfile = profileId.startsWith('custom:');
  const isPublicProfile = profile.access.level === 'public';
  const userTools = await resolveUserTools(userId, userRole);

  const effectiveTools =
    isCustomProfile || isPublicProfile
      ? userTools.activeTools.filter((t) => profile.tools.includes(t))
      : userTools.activeTools;

  return { effectiveTools };
}

export interface LazyServerToolContext {
  userId: string | null;
  userRole: string;
  sessionId?: string;
  workspaceId?: string | null;
  /** Profile of the running session — used to pick the sub-call / child model. */
  profileId?: string | null;
  /**
   * The shared static tool registry. Required to wire `spawn_session` (it needs
   * the registry to assemble a child session's tool set). Absent on the stateless
   * proxy/MCP surfaces, so spawn_session simply doesn't activate there.
   */
  toolRegistry?: ToolRegistry;
}

/**
 * Assemble the per-request lazy *server* tools that both the chat route and the
 * agent proxy share (feature_request, project_manager, email_manager,
 * personal_knowledge, session_history).
 *
 * Returns a partial registry the caller merges into its tool set. Does NOT
 * include local tools.
 */
export function buildLazyServerTools(
  db: DatabaseProvider,
  effectiveTools: string[],
  ctx: LazyServerToolContext,
): ToolRegistry {
  const { userId, userRole, sessionId } = ctx;
  const tools: ToolRegistry = {};

  if (effectiveTools.includes('feature_request')) {
    tools.feature_request = createFeatureRequestTool(db, {
      userId: userId ?? 'anonymous',
      userRole,
      sessionId: sessionId ?? undefined,
    });
  }
  if (effectiveTools.includes('project_manager')) {
    tools.project_manager = createProjectManagerTool(db, {
      userId: userId ?? 'anonymous',
      userRole,
    });
  }
  if (effectiveTools.includes('email_manager') && userId) {
    tools.email_manager = createEmailManagerTool(db, { userId });
  }
  // Split read/write email tools for the proxy/MCP surface. The MCP route derives
  // them from the user's email_manager grant (see resolveMcpContext) rather than
  // standalone per-user assignment.
  if (effectiveTools.includes('email_query') && userId) {
    tools.email_query = createEmailQueryTool(db, { userId });
  }
  if (effectiveTools.includes('email_mutation') && userId) {
    tools.email_mutation = createEmailMutationTool(db, { userId });
  }
  if (effectiveTools.includes('personal_knowledge') && userId) {
    tools.personal_knowledge = createPersonalKnowledgeTool(db, { userId });
  }
  // session_history is available to all internal users (independent of memory feature)
  if (effectiveTools.includes('session_history') && userId && userId !== 'external') {
    tools.session_history = createSessionHistoryTool(db, { userId });
  }
  if (userId && userId !== 'external') {
    if (effectiveTools.includes('project_query')) {
      tools.project_query = createProjectQueryTool(db, { userId, userRole });
    }
    if (effectiveTools.includes('project_mutation')) {
      tools.project_mutation = createProjectMutationTool(db, { userId, userRole });
    }
    if (effectiveTools.includes('session_query')) {
      tools.session_query = createSessionQueryTool(db, { userId, userRole });
    }
    if (effectiveTools.includes('knowledge_query')) {
      tools.knowledge_query = createKnowledgeQueryTool(db, { userId });
    }
    if (effectiveTools.includes('knowledge_mutation')) {
      tools.knowledge_mutation = createKnowledgeMutationTool(db, { userId });
    }
  }

  // ── Session orchestration tools (session-scoped) ──
  // call_llm and spawn_session only make sense inside a running session: call_llm
  // audits to it, spawn_session links children to it. The stateless proxy/MCP
  // surfaces pass no sessionId, so these never activate there.
  if (userId && userId !== 'external' && sessionId) {
    const uid = userId;
    const parentSessionId = sessionId;
    if (effectiveTools.includes('call_llm')) {
      tools.call_llm = createCallLlmTool(db, {
        userId: uid,
        sessionId: parentSessionId,
        profileId: ctx.profileId ?? null,
      });
    }
    if (effectiveTools.includes('spawn_session') && ctx.toolRegistry) {
      const toolRegistry = ctx.toolRegistry;
      tools.spawn_session = createSpawnSessionTool(db, {
        userId: uid,
        userRole,
        parentSessionId,
        parentProfileId: ctx.profileId ?? null,
        // Assemble a child's tools through the SAME resolution path as a top-level
        // session — so the child's set is always ⊆ the caller's permissions — and
        // strip spawn_session once the depth cap is reached to bound recursion.
        assembleChildTools: async ({ childSessionId, profile, depth }) => {
          const { effectiveTools: childEff } = await resolveEffectiveTools({
            userId: uid,
            userRole,
            profile,
            profileId: profile.id,
          });
          const ids = childSpawnToolIds(childEff, depth);
          const childTools = selectTools(
            toolRegistry,
            ids.filter((t) => !LAZY_TOOL_IDS.has(t)),
          );
          Object.assign(
            childTools,
            buildLazyServerTools(db, ids, {
              userId: uid,
              userRole,
              sessionId: childSessionId,
              workspaceId: ctx.workspaceId,
              profileId: profile.id,
              toolRegistry,
            }),
          );
          return childTools;
        },
      });
    }
  }

  return tools;
}
