/**
 * Automation opt-in tool catalog — the set of tools an automation OWNER may
 * explicitly grant to their own unattended runs.
 *
 * Background: `filterUnattendedToolIds` (apps/api) fails closed to a small
 * whitelist of replay-safe reads, so an unattended run can reach no write tool
 * at all. That single rule was bundling three unrelated reasons for refusing —
 * "the confirm gate needs a human reading a card", "this multiplies itself",
 * and "this merely costs money or writes a reversible internal row". Only the
 * first two survive a one-time consent at configuration time; this catalog is
 * the third group, plus the paid/durable reads. Web search (external_search) is
 * not here: it is granted to every unattended run automatically.
 *
 * Ticking a box here NEVER widens permissions. The runtime set is
 * `opt-in ∩ this catalog ∩ the owner's currently effective tools`, recomputed
 * on every execution — so a revoked flag or role takes effect on the next run
 * with nobody having to revisit the checkbox.
 *
 * Deliberately NOT here, and not to be added (each for its own reason — see
 * spec D2, docs/specs/20260824-automation-optin-tools.md):
 *   • email_mutation      — the only irreversible outbound channel, and all of
 *                           its safety is a human reading the draft card.
 *   • automation_mutation — an automation that creates automations.
 *   • skill_mutation      — skills are shared org-wide; writing one rewrites
 *                           every agent that installs it.
 *   • tables_schema_plan / task_capture,
 *     ask_user            — they only produce a card nobody will press, or a
 *                           question nobody will answer.
 *
 * This table lives in @greenhouse/types (not on each tool's `defineTool` meta)
 * because the server-side validator is `scheduler/task-center.ts`, and
 * `tools/registry.ts → tools/automation-mutation.ts → scheduler/task-center.ts`
 * is an existing import chain: importing the registry back from task-center
 * would close a cycle and reintroduce the module-evaluation TDZ that once made
 * the API fail to boot while every unit test stayed green. A zero-dependency
 * leaf is safe from both sides, and the browser can read the same table.
 * The parity guard is apps/api/src/scheduler/__tests__/automation-opt-in-catalog.test.ts.
 */

/**
 * `assist` — no business-data write. Costs money, or touches only the owner's
 * own things. A single consent at configuration time is a fair substitute for
 * the per-call gate, because there is no per-call decision to make.
 *
 * `write`  — writes internal business records. Every one of them is reversible
 * (soft delete, recycle bin, or a field-level change log), which is exactly the
 * line between this tier and the tools that are not in the catalog at all.
 */
export type AutomationOptInTier = 'assist' | 'write';

export interface AutomationOptInTool {
  id: string;
  tier: AutomationOptInTier;
  order?: number;
  labelKey?: `ext.${string}`;
}

const CORE_OPT_IN_TOOLS: AutomationOptInTool[] = [
  { id: 'analyze_image', tier: 'assist', order: 10 },
  { id: 'generate_image', tier: 'assist', order: 20 },
  { id: 'export_data', tier: 'assist', order: 30 },
  { id: 'tables_mutation', tier: 'write', order: 50 },
  { id: 'knowledge_mutation', tier: 'write', order: 60 },
  { id: 'mcp_call', tier: 'write', order: 90 },
];
export const AUTOMATION_OPT_IN_TOOLS: AutomationOptInTool[] = [...CORE_OPT_IN_TOOLS];
export const AUTOMATION_OPT_IN_TOOL_IDS = new Set(AUTOMATION_OPT_IN_TOOLS.map((tool) => tool.id));
export let MAX_AUTOMATION_OPT_IN_TOOLS = AUTOMATION_OPT_IN_TOOLS.length;
/** Replace plugin contributions when a deployment is assembled or the client changes station. */
export function setExtensionAutomationTools(tools: readonly AutomationOptInTool[]): void {
  const seen = new Set(CORE_OPT_IN_TOOLS.map((tool) => tool.id));
  for (const tool of tools) {
    if (seen.has(tool.id)) throw new Error(`Duplicate automation opt-in tool ${tool.id}`);
    seen.add(tool.id);
  }
  AUTOMATION_OPT_IN_TOOLS.splice(
    0,
    AUTOMATION_OPT_IN_TOOLS.length,
    ...[...CORE_OPT_IN_TOOLS, ...tools].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
  );
  AUTOMATION_OPT_IN_TOOL_IDS.clear();
  for (const tool of AUTOMATION_OPT_IN_TOOLS) AUTOMATION_OPT_IN_TOOL_IDS.add(tool.id);
  MAX_AUTOMATION_OPT_IN_TOOLS = AUTOMATION_OPT_IN_TOOLS.length;
}

export function isAutomationOptInTool(id: string): boolean {
  return AUTOMATION_OPT_IN_TOOL_IDS.has(id);
}

export function automationOptInTier(id: string): AutomationOptInTier | null {
  return AUTOMATION_OPT_IN_TOOLS.find((t) => t.id === id)?.tier ?? null;
}

/**
 * Normalise whatever is stored in / posted to `automations.unattended_tools`
 * into a deduplicated, catalog-ordered list of known ids.
 *
 * Read paths use this so a tool that later leaves the catalog stops being
 * honoured without a data migration; the WRITE path rejects unknown ids loudly
 * instead (an id the user typed and we silently dropped is a checkbox that
 * lies).
 */
export function normalizeAutomationOptInTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && AUTOMATION_OPT_IN_TOOL_IDS.has(entry)) seen.add(entry);
  }
  return AUTOMATION_OPT_IN_TOOLS.filter((t) => seen.has(t.id)).map((t) => t.id);
}
