/**
 * Agent runtime — shared tool resolution.
 *
 * Single source of truth for "which tools does this (user, profile) get, and how
 * are the per-request lazy server tools assembled". Used by both `/api/chat`
 * (session-authenticated) and `/api/agent/*` (API-key authenticated) so the two
 * never fork their permission logic.
 *
 * NOTE: browser client actions are not handled here — they carry route-specific
 * UX (NDJSON bridge writers) and stay in the chat route.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import { fromExtensions } from '../extensions/index.js';
import { normalizeAutomationOptInTools } from '@greenhouse/types/automation-tools';
import { resolveUserTools, selectTools } from '../agent.js';
import type { ToolRegistry } from '../agent.js';
import { createFeatureRequestTool } from '../tools/feature-request.js';
// Derived from the catalog (kind !== 'static' + route-constructed special metas) — see registry.
import {
  BUILTIN_AGENT_TOOL_IDS,
  getToolMeta,
  LAZY_TOOL_IDS,
  RETIRED_TOOL_ALIASES,
  WORKBENCH_READ_TOOL_IDS,
} from '../tools/registry.js';
export { LAZY_TOOL_IDS };
import { createSpawnSessionTool, MAX_SPAWN_DEPTH } from '../tools/spawn-session.js';
import { createCallLlmTool } from '../tools/call-llm.js';
import { createProjectQueryTool } from '../tools/project-query.js';
import { createProjectMutationTool } from '../tools/project-mutation.js';
import { createSessionQueryTool } from '../tools/session-query.js';
import { createKnowledgeQueryTool } from '../tools/knowledge-query.js';
import { createKnowledgeMutationTool } from '../tools/knowledge-mutation.js';
import { createSkillMutationTool } from '../tools/skills/skill-mutation.js';
import { createAutomationQueryTool } from '../tools/automation-query.js';
import { createAutomationMutationTool } from '../tools/automation-mutation.js';
import { createEmailQueryTool } from '../tools/email-query.js';
import { createEmailMutationTool } from '../tools/email-mutation.js';
import { createMemoryTool } from '../tools/memory.js';
import type { ToolSource } from '@greenhouse/types/workbench';
import { createWorkbenchQueryTool, createWorkbenchMutationTool } from '../tools/workbench.js';
import { createWorkbenchEvaluator } from '../workbench/evaluate.js';
import { delegatedAgentActor } from '../platform/actor.js';
import { getPlatformRuntime } from '../platform/runtime.js';
import { createLogFrictionTool } from '../tools/log-friction.js';
import { createEvalMessageTool } from '../tools/eval-message.js';
import { createGenerateImageTool } from '../tools/generate-image.js';
import { createAnalyzeImageTool } from '../tools/analyze-image.js';
import { createTablesQueryTool } from '../tools/tables-query.js';
import { createTablesMutationTool } from '../tools/tables-mutation.js';
import { createTablesSchemaPlanTool } from '../tools/tables-schema-plan.js';
import { createExportDataTool } from '../tools/export-data.js';
import { createWorkflowPlanTool } from '../tools/workflow-plan.js';
import { createMissionDispatchTool } from '../tools/mission-dispatch.js';
import { createTaskCaptureTool } from '../tools/task-capture.js';
import { createReadAttachmentTool } from '../tools/read-attachment.js';
import type { AgentProfile } from '../profiles/profile.js';

/**
 * Draft-only tools whose confirm surface is a card in a HUMAN conversation — a
 * workflow graph, a cloud sandbox mission, a Tables schema change. A headless
 * child session has no user to press Confirm or Launch, so a draft made there
 * would just strand. They are stripped from every derived tool face: workflow
 * nodes (NODE_TOOL_DENYLIST) and spawned sub-sessions (below).
 */
export const DISPATCH_TOOL_IDS: readonly string[] = [
  'workflow_plan',
  'mission_dispatch',
  'tables_schema_plan',
  'task_capture',
];

/**
 * Tool ids a child session may hold at a given lineage depth. Dispatch tools
 * never reach a child (see above). spawn_session is additionally removed once
 * the depth cap is reached, so a sub-session can never spawn an endless chain
 * of grandchildren. call_llm has no recursion vector and is kept.
 */
export function childSpawnToolIds(ids: string[], depth: number): string[] {
  const kept = filterUnattendedToolIds(ids).filter((t) => !DISPATCH_TOOL_IDS.includes(t));
  return depth >= MAX_SPAWN_DEPTH ? kept.filter((t) => t !== 'spawn_session') : kept;
}

export interface ResolveEffectiveToolsArgs {
  userId: string;
  userRole: string;
  profile: AgentProfile;
  profileId: string;
}

export interface EffectiveToolsResult {
  /**
   * The tools effective for this request after profile intersection. This is
   * the ONLY tool set callers may expose to the model (tools[] and prompts
   * alike) — the user's full un-narrowed allow-set must not leave this module,
   * or internal tool names leak into profile-narrowed sessions.
   */
  effectiveTools: string[];
}

/**
 * Resolve the effective tool set for a (user, profile) pair.
 *
 * - Custom profiles intersect their declared tools with the user's allowed set
 *   (a profile can only narrow, never widen, user permissions).
 * - Built-in internal profiles grant the full user-allowed set.
 */
export async function resolveEffectiveTools(args: ResolveEffectiveToolsArgs): Promise<EffectiveToolsResult> {
  const { userId, userRole, profile, profileId } = args;

  const isCustomProfile = profileId.startsWith('custom:');
  const userTools = await resolveUserTools(userId, userRole);

  // Custom profiles persist tool id arrays in the DB; expand retired ids to
  // their successors so a tool retirement never silently strips a saved agent.
  //
  // The built-ins join the FILTER, not the result. Written the other way round
  // — unioned into `effectiveTools` below — this would hand out tools the user
  // does not have: `memory` to someone whose flag is off, or a super-only tool
  // to a team member. The intersection with `activeTools` is what keeps the
  // module's promise that a profile can only ever narrow.
  const profileTools = isCustomProfile
    ? new Set([...profile.tools.flatMap((t) => [t, ...(RETIRED_TOOL_ALIASES[t] ?? [])]), ...BUILTIN_AGENT_TOOL_IDS])
    : null;

  const effectiveTools = profileTools
    ? userTools.activeTools.filter((t) => profileTools.has(t))
    : userTools.activeTools;

  return { effectiveTools };
}

export interface LazyServerToolContext {
  userId: string;
  userRole: string;
  sessionId?: string;
  workspaceId?: string | null;
  /** Bind workspace-aware tool inputs to workspaceId (proxy/task credentials). */
  lockWorkspace?: boolean;
  /** Profile of the running session — used to pick the sub-call / child model. */
  profileId?: string | null;
  /**
   * The shared static tool registry. Required to wire `spawn_session` (it needs
   * the registry to assemble a child session's tool set). Absent on the stateless
   * proxy/MCP surfaces, so spawn_session simply doesn't activate there.
   */
  toolRegistry?: ToolRegistry;
  /**
   * No human is present for the rest of the turn — scheduled-task runs and
   * workflow nodes. Tools that stay available here may still need to narrow what
   * they will do. Dropping a tool outright is UNATTENDED_TOOL_DENYLIST's job instead.
   */
  unattended?: boolean;
  /** Current durable parent Run; spawn_session uses it for root lineage. */
  runtimeRunId?: string | null;
}

/**
 * Assemble the per-request lazy *server* tools that both the chat route and the
 * agent proxy share (feature_request, knowledge_query, session_query, …).
 *
 * Returns a partial registry the caller merges into its tool set. Does NOT
 * include browser client actions (route-specific).
 */
/**
 * Tools denied in every UNATTENDED context — scheduled-task runs and workflow
 * nodes, where no human is present for the rest of the turn.
 *
 * Today that is the automation writer: its real gate is the user agreeing to a
 * schedule, and nobody is there to give it. Worse, a scheduled run able to
 * create scheduled runs multiplies on its own — quota and model budget both
 * drain without anyone watching. Workflow nodes deny more on top of this (see
 * NODE_TOOL_DENYLIST in workflow-engine); the read-only automation_query is
 * harmless and stays available so an unattended run can still report state.
 *
 * email_mutation joins it for the same reason and one more: its safety rests
 * entirely on a human reading the draft card and agreeing. Unattended there is
 * no card and no reader, so the two-step confirmation would degrade into a
 * one-step send. Automation that needs to deliver by email uses the scheduler's
 * own channel (scheduler/notify.ts), which no model can aim.
 */
export const UNATTENDED_TOOL_DENYLIST = new Set(['automation_mutation', 'email_mutation']);

/**
 * The automatic baseline is fail-closed: an unattended execution receives only
 * tools explicitly catalogued as replay-safe reads. `proxy:'read'` alone is not
 * enough: generate_image, analyze_image and external_search cross paid provider
 * boundaries and generation also persists a durable object. Tools with no
 * explicit replay-safe declaration are denied.
 */
function isAutomaticUnattendedTool(toolId: string): boolean {
  return (
    !UNATTENDED_TOOL_DENYLIST.has(toolId) &&
    !DISPATCH_TOOL_IDS.includes(toolId) &&
    getToolMeta(toolId)?.surface?.proxy === 'read' &&
    getToolMeta(toolId)?.surface?.unattendedReplaySafe === true
  );
}

/**
 * Tools available to an unattended execution.
 *
 * `optInToolIds` is the automation OWNER's explicit per-task grant (see
 * docs/specs/20260824-automation-optin-tools.md). It is an EXPLICIT parameter
 * rather than a default or an ambient context on purpose: this function has
 * three consumers — the scheduler executor, `childSpawnToolIds` (spawned
 * sub-sessions) and the workflow node tool face — and only the first one has a
 * human who ticked a box at configuration time. A default value here would leak
 * the grant into the other two silently.
 *
 * The two branches are a UNION, and the automatic branch is untouched: an
 * opt-in can only ever ADD from the published catalog, never relax the
 * replay-safe test for everything else. And because the caller passes the
 * owner's freshly resolved `effectiveTools` as `ids`, a grant can never widen
 * permissions — a revoked flag or role drops the tool on the very next run.
 */
export function filterUnattendedToolIds(ids: string[], optInToolIds: readonly string[] = []): string[] {
  const optIn = optInToolIds.length > 0 ? new Set(normalizeAutomationOptInTools(optInToolIds)) : null;
  return ids.filter(
    (toolId) =>
      isAutomaticUnattendedTool(toolId) ||
      (optIn !== null &&
        optIn.has(toolId) &&
        !UNATTENDED_TOOL_DENYLIST.has(toolId) &&
        !DISPATCH_TOOL_IDS.includes(toolId)),
  );
}

/**
 * The inline tool face of a browser-extension conversation
 * (`sessions.channel = 'browser'`).
 *
 * The Greenhouse Bridge side panel puts the web page the user is reading into
 * the turn (their selection, or the page text for "summarize"), and its browser
 * actions read more pages while the agent works. That page content is
 * untrusted input sitting next to the user's own data, so the model gets no
 * inline way to change anything. The face is fail-closed: declared reads
 * (`surface.proxy: 'read'`) plus the output-only tools below. A writer the
 * catalog gains later stays out until someone decides otherwise here.
 *
 * The panel's one write path is its `save_to_knowledge` Client Action, which
 * shows a confirm card before it calls the confirm-gated agent proxy
 * (apps/browser/src/lib/knowledge-tools.ts). Client Actions are registered by
 * the chat route after this filter runs, so they are unaffected by it.
 *
 * Keyed on the session's server-recorded channel, never on a per-request flag:
 * it holds for every turn of the conversation, including when the web app
 * continues it, because the history still carries page-derived text. (The
 * extension used to send `omit_write_tools: true` per turn; a server that
 * stopped reading that flag silently handed every writer back.) Deliberately
 * NOT `UNATTENDED_TOOL_DENYLIST` (nobody can press confirm) nor the Feishu
 * denylist (the surface cannot carry a card): this one is about untrusted input.
 */
const BROWSER_OUTPUT_ONLY_TOOL_IDS: ReadonlySet<string> = new Set(['ask_user', 'export_data']);

export function filterBrowserSessionToolIds(toolIds: readonly string[]): string[] {
  return toolIds.filter((id) => getToolMeta(id)?.surface?.proxy === 'read' || BROWSER_OUTPUT_ONLY_TOOL_IDS.has(id));
}

export function buildLazyServerTools(
  db: DatabaseProvider,
  effectiveTools: string[],
  ctx: LazyServerToolContext,
): ToolRegistry {
  const { userId, userRole, sessionId } = ctx;
  const tools: ToolRegistry = {};

  // Cost-bearing provider tool: built per request so budget attribution is
  // bound to the authenticated internal owner on Chat, Agent Proxy and MCP.
  if (effectiveTools.includes('generate_image')) {
    tools.generate_image = createGenerateImageTool({
      db,
      userId,
      sessionId,
    });
  }
  if (effectiveTools.includes('analyze_image')) {
    tools.analyze_image = createAnalyzeImageTool({
      db,
      userId,
      sessionId,
    });
  }

  // eval_message: needs the running Agent sessionId (→ eval_session_id) so the chat
  // UI can later restore this eval conversation. It is gated by the authenticated
  // user's admin tool grant, same as when it was static.
  if (effectiveTools.includes('eval_message')) {
    tools.eval_message = createEvalMessageTool(db, {
      userId,
      userRole,
      evalSessionId: sessionId ?? null,
    });
  }
  if (effectiveTools.includes('feature_request')) {
    tools.feature_request = createFeatureRequestTool(db, {
      userId,
      userRole,
      sessionId: sessionId ?? undefined,
    });
  }
  if (effectiveTools.includes('project_query')) {
    tools.project_query = createProjectQueryTool(db, { userId });
  }
  if (effectiveTools.includes('project_mutation')) {
    tools.project_mutation = createProjectMutationTool({ userId });
  }
  if (effectiveTools.includes('tables_query')) {
    tools.tables_query = createTablesQueryTool({ userId });
  }
  if (effectiveTools.includes('tables_mutation')) {
    tools.tables_mutation = createTablesMutationTool({ userId });
  }
  if (effectiveTools.includes('tables_schema_plan')) {
    tools.tables_schema_plan = createTablesSchemaPlanTool({ userId });
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
  // Skill Center writes — owner/super checks live in skills/center.ts; the
  // read side (skill_query) is static and comes from the base registry.
  if (effectiveTools.includes('skill_mutation')) {
    tools.skill_mutation = createSkillMutationTool(db, { userId, userRole });
  }
  // Automations (scheduled tasks) — owner-scoped inside the tools themselves, so
  // deliberately NOT session-scoped: an automation belongs to a user, not to a
  // conversation, and the stateless proxy/MCP surfaces must reach it too.
  if (effectiveTools.includes('automation_query')) {
    tools.automation_query = createAutomationQueryTool(db, { userId, userRole });
  }
  if (effectiveTools.includes('automation_mutation')) {
    tools.automation_mutation = createAutomationMutationTool(db, { userId, userRole });
  }

  // Email — mailbox ownership is checked inside the tools, so like automations
  // these are not session-scoped. sessionId is passed only so attachments can
  // resolve on the chat surface; without it the attachment path says so plainly.
  if (effectiveTools.includes('email_query')) {
    tools.email_query = createEmailQueryTool(db, { userId, userRole, sessionId });
  }
  if (effectiveTools.includes('email_mutation')) {
    tools.email_mutation = createEmailMutationTool(db, { userId, userRole, sessionId });
  }

  // Memory + friction logging — owner-scoped inside the tools. sessionId is only
  // provenance (which conversation produced this), never the access boundary, so
  // both stay available on headless runs where there is no session.
  if (effectiveTools.includes('memory')) {
    tools.memory = createMemoryTool(db, { userId, sessionId });
  }
  if (effectiveTools.includes('log_friction')) {
    tools.log_friction = createLogFrictionTool(db, { sessionId });
  }

  // Home workbench — owner-scoped inside the tools. Cards may only bind tools
  // the user can already read, so the evaluator gets the read-only intersection
  // and the registry it should run against.
  //
  // That registry is read *when a card is evaluated*, not now: `tools` is still
  // being filled in on this line, and building a second registry here would
  // recurse straight back into this function.
  if (effectiveTools.includes('workbench_query') || effectiveTools.includes('workbench_mutation')) {
    const readableToolIds = effectiveTools.filter((id) => WORKBENCH_READ_TOOL_IDS.has(id));
    const evaluator = createWorkbenchEvaluator({
      userId,
      registry: { ...(ctx.toolRegistry ?? {}), ...tools },
      readableToolIds,
    });
    const workbenchContext = {
      userId,
      readableToolIds,
      evaluate: (source: ToolSource) => evaluator.evaluateSource(source),
      evaluateNav: evaluator.evaluateNavTarget,
      listVisibleApplicationIds: async () =>
        (await getPlatformRuntime().listVisibleApplications(delegatedAgentActor({ userId }))).map(
          ({ manifest }) => manifest.id,
        ),
    };
    if (effectiveTools.includes('workbench_query')) {
      tools.workbench_query = createWorkbenchQueryTool(db, workbenchContext);
    }
    if (effectiveTools.includes('workbench_mutation')) {
      tools.workbench_mutation = createWorkbenchMutationTool(db, workbenchContext);
    }
  }

  // ── Session orchestration tools (session-scoped) ──
  // call_llm and spawn_session only make sense inside a running session: call_llm
  // audits to it, spawn_session links children to it. The stateless proxy/MCP
  // surfaces pass no sessionId, so these never activate there.
  if (sessionId) {
    const uid = userId;
    const parentSessionId = sessionId;
    if (effectiveTools.includes('export_data')) {
      tools.export_data = createExportDataTool(db, { userId: uid, sessionId: parentSessionId });
    }
    // workflow_plan: any session, not just the Sprouty (workflows) preset. The
    // plan card and the dock are keyed by session, so the confirm surface exists
    // wherever the tool runs — and the model can only DRAFT, never execute, so
    // an ordinary chat can escalate into an orchestration without the user
    // having to pick the mode up front (session-modes spec L3).
    if (effectiveTools.includes('workflow_plan')) {
      tools.workflow_plan = createWorkflowPlanTool(db, { userId: uid, sessionId: parentSessionId });
    }
    // mission_dispatch: same shape as workflow_plan — drafts a task card whose
    // Launch button is the only way a sandbox run starts. Entitlement is the
    // `cloud-agent` feature flag, resolved upstream in resolveUserTools.
    if (effectiveTools.includes('mission_dispatch')) {
      tools.mission_dispatch = createMissionDispatchTool(db, { userId: uid, sessionId: parentSessionId });
    }
    // task_capture: session-scoped because the whole point is distilling THIS
    // conversation — including reading back which tools it really used, which
    // no stateless caller could supply.
    if (effectiveTools.includes('task_capture')) {
      tools.task_capture = createTaskCaptureTool(db, { userId: uid, sessionId: parentSessionId });
    }
    // read_attachment: session-scoped because the session bound IS the
    // authorization — the model supplies the file id, so a copied one must not
    // reach another conversation's attachment.
    if (effectiveTools.includes('read_attachment')) {
      tools.read_attachment = createReadAttachmentTool(db, {
        userId: uid,
        sessionId: parentSessionId,
        canDispatchMission: effectiveTools.includes('mission_dispatch'),
      });
    }
    if (effectiveTools.includes('call_llm')) {
      tools.call_llm = createCallLlmTool(db, {
        userId: uid,
        sessionId: parentSessionId,
        profileId: ctx.profileId ?? null,
      });
    }
    if (effectiveTools.includes('spawn_session') && ctx.toolRegistry && (userRole === 'team' || userRole === 'super')) {
      const toolRegistry = ctx.toolRegistry;
      tools.spawn_session = createSpawnSessionTool(db, {
        userId: uid,
        userRole,
        parentSessionId,
        parentProfileId: ctx.profileId ?? null,
        parentRuntimeRunId: ctx.runtimeRunId ?? null,
        workspaceId: ctx.workspaceId ?? null,
        // Assemble a child's tools through the SAME resolution path as a top-level
        // session — so the child's set is always ⊆ the caller's permissions — and
        // strip spawn_session once the depth cap is reached to bound recursion.
        assembleChildTools: async ({ childSessionId, profile, depth, runtimeRunId }) => {
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
              unattended: true,
              runtimeRunId,
            }),
          );
          return childTools;
        },
      });
    }
  }

  // Extension lazy tools take the generic path: no per-tool case needed in core.
  for (const mod of fromExtensions('tools')) {
    if (mod.kind !== 'lazy' || !mod.createLazy || !effectiveTools.includes(mod.meta.id)) continue;
    tools[mod.meta.id] = mod.createLazy({
      db,
      userId,
      userRole,
      sessionId,
      workspaceId: ctx.workspaceId ?? null,
      lockWorkspace: ctx.lockWorkspace ?? false,
      profileId: ctx.profileId ?? null,
      unattended: ctx.unattended ?? false,
    });
  }

  return tools;
}
