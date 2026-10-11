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
import { defineTool, type ToolMeta } from './define.js';
import { dispatchTablesAgentAction } from '../platform/tables/agent-adapter.js';
import { grantableGroups } from '../platform/tables/directory.js';
import { schemaPlanOperationSchema, MAX_SCHEMA_PLAN_OPERATIONS } from '../platform/tables/schema-plan.js';
import { draftSchemaPlan, type SchemaPlanReader } from '../platform/tables/schema-plan-draft.js';

const schemaPlanSchema = z.object({
  summary: z.string().min(1).max(500).describe("One line describing the change, in the user's language."),
  operations: z.array(schemaPlanOperationSchema).min(1).max(MAX_SCHEMA_PLAN_OPERATIONS).describe('Applied in order.'),
});

type SchemaPlanInput = z.infer<typeof schemaPlanSchema>;

export interface TablesSchemaPlanContext {
  userId: string;
}

/** Everything the draft check reads, as the drafting user (the delegated agent actor). */
function schemaPlanReader(userId: string): SchemaPlanReader {
  return {
    userId,
    dispatch: (actionId, payload, ids) => dispatchTablesAgentAction({ userId }, actionId, payload, ids),
    grantableGroups: () => grantableGroups(getDb(), userId),
  };
}

// ─── Tool ────────────────────────────────────────────────

const meta: ToolMeta = {
  id: 'tables_schema_plan',
  name: 'Tables Schema Plan',
  brief: 'Draft Tables structure, views, forms, automations, dashboards and access for the user to confirm',
  description: `Draft a change to internal Tables — Bases, tables, fields, views (grid/kanban/calendar/gallery), submit-only forms, automations, dashboards and widgets, custom roles, who has access — as a card the user confirms.

NOTHING changes until they press Confirm. Never say an object exists, or cite its id, in the turn you drafted it.

Every existing id comes from tables_query (bases.list → tables.list → schema.get; forms.list, automations.list, dashboard.get, roles.list; people and groups via directory.search), never from memory; updates carry the revision you read. Read a config's JSON shape with tables_query builder.reference before writing one.

To use something created earlier in the same plan, give its create a ref and point at it with tableRef/baseRef/dashboardRef/roleRef, or anywhere inside a config with the string "$field:<ref>" ($table/$view/$form/$automation/$dashboard/$role too) — as a value or as an object key.

An invalid plan comes back with every problem listed — fix them all and draft again.

Creating a Base also creates one table: name it with defaultTableName + defaultTableRef and put your fields in it. Every new table already has a required primary text field "Name" and a Grid view — don't add your own title field. ALWAYS describe a new Base/table (what it holds, field conventions).

A formula config takes an AST, not a string (builder.reference topic=plan).

CANNOT do — never promise it: change a field's TYPE (add a new field instead), delete a table or Base (the user does that in the sidebar: right-click → Delete, creator only, archived so an admin can restore it), add or change a webhook (a person does that in the automation editor). Records are tables_mutation's job. Structure needs the builder role; roles, members and Base settings the owner's.`,
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
        const draft = await draftSchemaPlan(input.operations, schemaPlanReader(ctx.userId));
        if (!draft.ok) {
          const count = draft.problems.length;
          return {
            error: `The plan was not drafted — fix ${count === 1 ? 'this problem' : `these ${count} problems`} and call tables_schema_plan again:\n${draft.problems.map((problem) => `- ${problem}`).join('\n')}`,
            problems: draft.problems,
          };
        }
        const artifact: TablesSchemaPlanArtifact = {
          type: 'tables_schema_plan',
          summary: input.summary.trim(),
          operations: input.operations,
          ...(draft.accessChanges.length > 0 ? { accessChanges: draft.accessChanges } : {}),
        };
        return artifact;
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

export const tablesSchemaPlanTool = defineTool({ meta, kind: 'lazy' });
