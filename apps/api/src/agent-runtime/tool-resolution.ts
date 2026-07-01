/**
 * Agent runtime — shared tool resolution.
 *
 * Single source of truth for "which tools does this (user, profile) get, and how
 * are the per-request lazy server tools assembled". Used by both `/api/chat`
 * (session-authenticated) and `/api/agent/*` (API-key authenticated) so the two
 * never fork their permission logic.
 *
 * NOTE: the browser client-action bridge is intentionally NOT handled here — it
 * carries route-specific UX (NDJSON bridge writers) and stays in the chat route.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import { resolveUserTools, selectTools } from '../agent.js';
import type { ToolRegistry } from '../agent.js';
import { MAX_SPAWN_DEPTH } from '../tools/spawn-session.js';
import { LAZY_TOOL_MODULES } from '../tools/registry.js';
import type { ToolContext } from '../tools/define.js';
import type { AgentProfile } from '../profile.js';

/**
 * Tool IDs built per-request (the 'lazy' catalog) rather than from the static
 * registry — derived from each module's `kind`, no hand-maintained list. The
 * base `selectTools()` pass excludes these so it doesn't log misleading
 * "not found in registry" warnings. Single source: LAZY_TOOL_MODULES.
 */
export const LAZY_TOOL_IDS = new Set<string>(LAZY_TOOL_MODULES.map((m) => m.meta.id));

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
 * Assemble the per-request lazy *server* tools shared by the chat route, the
 * agent proxy, and the MCP route.
 *
 * Data-driven: it loops the lazy catalog and builds each tool the caller is
 * entitled to, enforcing that tool's declared `requires` — the SAME guards the
 * old hand-written if-ladder applied, now co-located with each tool:
 * - user 'required' → a real userId; 'internal' → a real, non-external userId.
 * - session        → a sessionId (session-scoped tools: call_llm, spawn_session).
 * - registry       → the shared registry, surfaced to the tool as
 *                    `assembleChildTools` (spawn_session) — never the raw set.
 *
 * Adding a lazy tool needs NO edit here: just export a
 * `defineTool({ kind:'lazy', requires, create })` module and list it in the
 * catalog. Returns a partial registry the caller merges into its tool set.
 */
export function buildLazyServerTools(
  db: DatabaseProvider,
  effectiveTools: string[],
  ctx: LazyServerToolContext,
): ToolRegistry {
  const tools: ToolRegistry = {};
  const hasUser = !!ctx.userId;
  const isInternal = hasUser && ctx.userId !== 'external';

  for (const mod of LAZY_TOOL_MODULES) {
    if (!mod.create || !mod.requires) continue;
    if (!effectiveTools.includes(mod.meta.id)) continue;

    const req = mod.requires;
    // User tier — identical to the previous per-tool guards.
    if (req.user === 'required' && !hasUser) continue;
    if (req.user === 'internal' && !isInternal) continue;
    // Session / registry tiers — session-scoped + orchestration tools.
    if (req.session && !ctx.sessionId) continue;
    if (req.registry && !ctx.toolRegistry) continue;

    const toolCtx: ToolContext = {
      db,
      // 'optional'-tier tools accept anonymous; every other tier passed its gate
      // only with a real user, so this fallback never masks a missing id.
      userId: ctx.userId ?? 'anonymous',
      userRole: ctx.userRole,
      sessionId: ctx.sessionId,
      profileId: ctx.profileId ?? null,
      workspaceId: ctx.workspaceId ?? null,
      assembleChildTools:
        req.registry && ctx.toolRegistry ? makeAssembleChildTools(db, ctx, ctx.toolRegistry) : undefined,
    };
    tools[mod.meta.id] = mod.create(toolCtx);
  }

  return tools;
}

/**
 * Build the depth-capped child-tool assembler handed to spawn_session. Kept here
 * (not in the tool file) so the assembler can recurse through the SAME resolution
 * path — child tool sets stay ⊆ the caller's permissions, and spawn_session is
 * stripped at the depth cap. The tool only ever sees this closure, never the raw
 * registry.
 */
function makeAssembleChildTools(
  db: DatabaseProvider,
  ctx: LazyServerToolContext,
  toolRegistry: ToolRegistry,
): NonNullable<ToolContext['assembleChildTools']> {
  return async ({ profile, depth, childSessionId }) => {
    const { effectiveTools: childEff } = await resolveEffectiveTools({
      userId: ctx.userId,
      userRole: ctx.userRole,
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
        userId: ctx.userId,
        userRole: ctx.userRole,
        sessionId: childSessionId,
        workspaceId: ctx.workspaceId,
        profileId: profile.id,
        toolRegistry,
      }),
    );
    return childTools;
  };
}
