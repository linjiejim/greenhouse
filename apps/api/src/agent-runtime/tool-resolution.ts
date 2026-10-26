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
import { resolveUserTools } from '../agent.js';
import type { ToolRegistry } from '../agent.js';
import { createFeatureRequestTool } from '../tools/feature-request.js';
import { createFilesQueryTool } from '../tools/files-query.js';
import { createFilesMutationTool } from '../tools/files-mutation.js';
import { createReportTemplatesTool } from '../tools/report-templates.js';
import { createReportRenderTool } from '../tools/report-render.js';
import { createFeedbackQueryTool } from '../tools/feedback-query.js';
// Derived from the catalog (kind !== 'static' + route-constructed special metas) — see registry.
import { BUILTIN_AGENT_TOOL_IDS, getToolMeta, LAZY_TOOL_IDS, RETIRED_TOOL_ALIASES } from '../tools/registry.js';
export { LAZY_TOOL_IDS };
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
import { createLogFrictionTool } from '../tools/log-friction.js';
import { createGenerateImageTool } from '../tools/generate-image.js';
import { createAnalyzeImageTool } from '../tools/analyze-image.js';
import { createTablesQueryTool } from '../tools/tables-query.js';
import { createTablesMutationTool } from '../tools/tables-mutation.js';
import { createTablesSchemaPlanTool } from '../tools/tables-schema-plan.js';
import { createExportDataTool } from '../tools/export-data.js';
import { createTaskCaptureTool } from '../tools/task-capture.js';
import { createReadAttachmentTool } from '../tools/read-attachment.js';
import { createMcpCallTool, MCP_CALL_TOOL_ID } from '../tools/mcp-call.js';
import type { ToolCallClient } from '@greenhouse/types/usage';
import type { AgentProfile } from '../profiles/profile.js';

/**
 * Draft-only tools whose confirm surface is a card in a HUMAN conversation — a
 * Tables schema change, a captured task. A headless run has no user to press
 * Confirm, so a draft made there would just strand. They are stripped from every
 * unattended tool face (scheduled runs).
 */
export const DISPATCH_TOOL_IDS: readonly string[] = ['tables_schema_plan', 'task_capture'];

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
  /** Profile of the running session — used to pick the sub-call model. */
  profileId?: string | null;
  /**
   * The shared static tool registry, for tools that need to call other static
   * tools. Absent on surfaces that don't pass it.
   */
  toolRegistry?: ToolRegistry;
  /**
   * No human is present for the rest of the turn — scheduled-task runs. Tools
   * that stay available here may still need to narrow what they will do.
   * Dropping a tool outright is UNATTENDED_TOOL_DENYLIST's job instead.
   */
  unattended?: boolean;
  /**
   * A person is typing this turn in the Greenhouse web or mobile chat
   * (routes/chat.ts, a `channel='web'` conversation). Only then may
   * `automation_mutation` store an owner's `unattended_tools` grant; MCP, the
   * agent proxy, bots and automation runs never set it.
   */
  humanChat?: boolean;
  /**
   * Build `mcp_call` for this surface. Only chat and automations pass it: the
   * `/api/agent` proxy never gets connectors, and `/api/mcp` builds its own
   * per request (routes/mcp.ts) because its write rules depend on the grant.
   */
  connectors?: {
    surface: 'chat' | 'automation';
    client: ToolCallClient;
    /** An agent's connector list (ids); null = every connector the member can use. */
    allowed: readonly string[] | null;
  };
}

/**
 * Assemble the per-request lazy *server* tools that both the chat route and the
 * agent proxy share (feature_request, knowledge_query, session_query, …).
 *
 * Returns a partial registry the caller merges into its tool set. Does NOT
 * include browser client actions (route-specific).
 */
/**
 * Tools denied in every UNATTENDED context — scheduled-task runs, where no
 * human is present for the rest of the turn.
 *
 * Today that is the automation writer: its real gate is the user agreeing to a
 * schedule, and nobody is there to give it. Worse, a scheduled run able to
 * create scheduled runs multiplies on its own — quota and model budget both
 * drain without anyone watching. The read-only automation_query is harmless and
 * stays available so an unattended run can still report state.
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
 * enough: generate_image and analyze_image cross paid provider boundaries and
 * generation also persists a durable object. external_search is paid too but is
 * declared replay-safe on purpose: it writes nothing, and its cost per run stays
 * bounded by the task's max_steps and the usage-budget refusal. Tools with no
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
 * rather than a default or an ambient context on purpose: only a caller with a
 * human who ticked a box at configuration time (the scheduler executor) may pass
 * one, and a default value here would leak the grant into any other caller
 * silently.
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
 * The extension (removed in 1.5) put the web page the user was reading into the
 * turn, so those conversations' history carries untrusted page text next to
 * the user's own data. Continuing one in the web app must still give the model
 * no inline way to change anything. The face is fail-closed: declared reads
 * (`surface.proxy: 'read'`) plus the output-only tools below. A writer the
 * catalog gains later stays out until someone decides otherwise here.
 *
 * Keyed on the session's server-recorded channel, never on a per-request flag.
 * Deliberately NOT `UNATTENDED_TOOL_DENYLIST` (nobody can press confirm) nor the
 * Feishu denylist (the surface cannot carry a card): this one is about
 * untrusted input.
 */
const BROWSER_OUTPUT_ONLY_TOOL_IDS: ReadonlySet<string> = new Set(['ask_user', 'export_data']);

/** Read-tier tools a browser-extension conversation still never gets: mcp_call reaches outside and can write. */
const BROWSER_DENIED_TOOL_IDS: ReadonlySet<string> = new Set(['mcp_call']);

export function filterBrowserSessionToolIds(toolIds: readonly string[]): string[] {
  return toolIds.filter(
    (id) =>
      !BROWSER_DENIED_TOOL_IDS.has(id) &&
      (getToolMeta(id)?.surface?.proxy === 'read' || BROWSER_OUTPUT_ONLY_TOOL_IDS.has(id)),
  );
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

  if (effectiveTools.includes('feature_request')) {
    tools.feature_request = createFeatureRequestTool(db, {
      userId,
      userRole,
      sessionId: sessionId ?? undefined,
    });
  }
  if (effectiveTools.includes('feedback_query')) {
    tools.feedback_query = createFeedbackQueryTool(db, { userId, userRole });
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
    tools.session_query = createSessionQueryTool(db, { userId, userRole, sessionId });
  }
  if (effectiveTools.includes('knowledge_query')) {
    tools.knowledge_query = createKnowledgeQueryTool(db, { userId });
  }
  if (effectiveTools.includes('knowledge_mutation')) {
    tools.knowledge_mutation = createKnowledgeMutationTool(db, { userId });
  }
  // Files (the knowledge cabinet) — every node is authorized inside
  // drive/kb-cabinet.ts, and like automations they belong to a user, not to a
  // conversation, so the stateless proxy/MCP surfaces reach them too.
  if (effectiveTools.includes('files_query')) {
    tools.files_query = createFilesQueryTool(db, { userId });
  }
  if (effectiveTools.includes('files_mutation')) {
    tools.files_mutation = createFilesMutationTool(db, { userId });
  }
  // Report templates (v1.7) — visibility and edit rights live in
  // reports/templates.ts; a rendered report is a new file in Files. Not
  // session-scoped, so Chat, the Agent API and MCP all reach them.
  if (effectiveTools.includes('report_templates')) {
    tools.report_templates = createReportTemplatesTool(db, { userId, userRole });
  }
  if (effectiveTools.includes('report_render')) {
    tools.report_render = createReportRenderTool(db, { userId, userRole });
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
    tools.automation_mutation = createAutomationMutationTool(db, {
      userId,
      userRole,
      canGrantTools: ctx.humanChat === true && ctx.unattended !== true,
    });
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

  // ── Session-scoped tools ──
  // These only make sense inside a running session (call_llm audits to it,
  // export_data / task_capture / read_attachment bind to it). The stateless
  // proxy/MCP surfaces pass no sessionId, so these never activate there.
  if (sessionId) {
    const uid = userId;
    const parentSessionId = sessionId;
    if (effectiveTools.includes('export_data')) {
      tools.export_data = createExportDataTool(db, { userId: uid, sessionId: parentSessionId });
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
      tools.read_attachment = createReadAttachmentTool(db, { userId: uid, sessionId: parentSessionId });
    }
    if (effectiveTools.includes('call_llm')) {
      tools.call_llm = createCallLlmTool(db, {
        userId: uid,
        sessionId: parentSessionId,
        profileId: ctx.profileId ?? null,
      });
    }
  }

  // Connectors: only on surfaces that asked for them (see LazyServerToolContext.connectors).
  if (ctx.connectors && effectiveTools.includes(MCP_CALL_TOOL_ID)) {
    const mcpCall = createMcpCallTool({
      db,
      userId,
      sessionId: sessionId ?? null,
      connectors: ctx.connectors.allowed,
      surface: ctx.connectors.surface,
      client: ctx.connectors.client,
    });
    if (mcpCall) tools[MCP_CALL_TOOL_ID] = mcpCall;
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
