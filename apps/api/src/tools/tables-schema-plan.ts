/**
 * Tables Schema Plan — the model drafts structural Tables changes in chat:
 * Bases, tables, fields, views, forms, automations, dashboards and widgets,
 * custom roles, and who has access.
 *
 * DRAFT-ONLY, exactly like `workflow_plan` and `mission_dispatch`: it creates
 * nothing and writes no row. It validates the plan and returns a
 * `tables_schema_plan` artifact the web renders as a card; the change is applied
 * only when the user presses Confirm on that card
 * (POST /api/tables/schema-plan/apply, reachable with the user's own bearer
 * token and absent from every model-facing tool table).
 *
 * The confirm gate is not ceremony. Record writes are individually visible in a
 * grid and trivially undone; a renamed field, a new role or a form opened to
 * everyone changes what many people see at once and is much harder to notice
 * after the fact. So the model's autonomy stops at drafting (spec D2).
 *
 * Validation happens before the card exists: the plan runs against a virtual
 * schema (what the user can read today + what the plan declares) through the
 * same validators the handlers use, and every problem goes back to the model
 * (`platform/tables/schema-plan-draft.ts`). The same pass derives the
 * permission changes the card lists before Confirm.
 *
 * Deliberately declares NO `surface`: schema editing stays off the Agent Proxy
 * and MCP, where no human is present to press anything (spec D3).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { TablesSchemaPlanArtifact } from '@greenhouse/types/tables';
import { activeUserHasFeature } from '../auth/features.js';
import { defineTool, type ToolMeta } from './define.js';
import { dispatchTablesAgentAction } from '../platform/tables/agent-adapter.js';
import { appReferencesTo } from '../platform/tables/app-references.js';
import { grantableGroups } from '../platform/tables/directory.js';
import { schemaPlanOperationSchema, MAX_SCHEMA_PLAN_OPERATIONS } from '../platform/tables/schema-plan.js';
import { draftSchemaPlan, type SchemaPlanReader } from '../platform/tables/schema-plan-draft.js';

export const schemaPlanSchema = z.object({
  summary: z.string().min(1).max(500).describe("One line describing the change, in the user's language."),
  operations: z.array(schemaPlanOperationSchema).min(1).max(MAX_SCHEMA_PLAN_OPERATIONS).describe('Applied in order.'),
});

export type SchemaPlanInput = z.infer<typeof schemaPlanSchema>;

export interface TablesSchemaPlanContext {
  userId: string;
}

/** Everything the draft check reads, as the drafting user (the delegated agent actor). */
function schemaPlanReader(userId: string): SchemaPlanReader {
  return {
    userId,
    dispatch: (actionId, payload, ids) => dispatchTablesAgentAction({ userId }, actionId, payload, ids),
    grantableGroups: () => grantableGroups(getDb(), userId),
    appsEnabled: () => activeUserHasFeature(userId, 'apps'),
    aiFieldsEnabled: () => activeUserHasFeature(userId, 'tables_ai_fields'),
    // Only asked for Bases the drafter builds on (field.archive / field.update need builder first).
    appReferences: (baseId, target) => appReferencesTo(getDb(), baseId, target),
  };
}

/**
 * Draft a plan as `userId`: the artifact a card shows, or every problem for the
 * model to fix. Shared by the chat tool (a card the user confirms) and the Bots
 * face (`bots/tools/tables-plan.ts`, a request the member approves).
 */
export async function draftTablesSchemaPlan(
  userId: string,
  input: SchemaPlanInput,
): Promise<{ ok: true; artifact: TablesSchemaPlanArtifact } | { ok: false; error: string; problems: string[] }> {
  const draft = await draftSchemaPlan(input.operations, schemaPlanReader(userId));
  if (!draft.ok) {
    const count = draft.problems.length;
    return {
      ok: false,
      error: `The plan was not drafted — fix ${count === 1 ? 'this problem' : `these ${count} problems`} and call tables_schema_plan again:\n${draft.problems.map((problem) => `- ${problem}`).join('\n')}`,
      problems: draft.problems,
    };
  }
  return {
    ok: true,
    artifact: {
      type: 'tables_schema_plan',
      summary: input.summary.trim(),
      operations: input.operations,
      ...(draft.accessChanges.length > 0 ? { accessChanges: draft.accessChanges } : {}),
      ...(Object.keys(draft.targetNames).length > 0 ? { targetNames: draft.targetNames } : {}),
    },
  };
}

// ─── Tool ────────────────────────────────────────────────

const meta: ToolMeta = {
  id: 'tables_schema_plan',
  name: 'Tables Schema Plan',
  brief: 'Draft Tables structure, views, forms, automations, dashboards, access and apps for the user to confirm',
  // Keep runtime/permission rules here; config grammar and examples stay in builder.reference.
  description: `Draft Tables structure, views, submit-only forms, automations, dashboards/widgets, roles, access and Base apps. Nothing changes until the user presses Confirm; never claim drafted objects exist or cite their IDs.

Read existing IDs and revisions via tables_query, never memory: bases.list → tables.list → schema.get; forms.list, automations.list, dashboard.get, roles.list; people/groups via directory.search. Updates require the read revision. Before writing configs, read builder.reference (app topic for apps; plan for formula ASTs, never formula strings).

Reference earlier creates via ref + tableRef/baseRef/dashboardRef/roleRef; in config keys/values use "$field:<ref>" (also $table/$view/$form/$automation/$dashboard/$role). Fix all returned validation problems and redraft.

A new Base includes a table: name/reuse it with defaultTableName/defaultTableRef. New tables include required primary text field "Name" and Grid view; don't add another title field. Describe each new Base/table's purpose and field conventions.

CANNOT change field types (create a field instead), delete tables/Bases (creator: sidebar right-click → Delete; archived, admin-restorable), add/change webhooks (use the automation editor), or build multi-level/parallel app approvals. Records: tables_mutation. Structure: builder role. Roles, members, Base settings, app publishing/sharing: Base owner.`,
  category: 'team',
  is_global: false,
  icon: 'Columns3',
  sort_order: 30,
  presentation: 'artifact',
};

export function createTablesSchemaPlanTool(ctx: TablesSchemaPlanContext) {
  return tool({
    description: meta.description,
    inputSchema: schemaPlanSchema,
    execute: async (input: SchemaPlanInput) => {
      try {
        const drafted = await draftTablesSchemaPlan(ctx.userId, input);
        return drafted.ok ? drafted.artifact : { error: drafted.error, problems: drafted.problems };
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

/** The chat description, for faces that add their own closing (the Bots face). */
export const TABLES_SCHEMA_PLAN_DESCRIPTION = meta.description;

export const tablesSchemaPlanTool = defineTool({ meta, kind: 'lazy' });
