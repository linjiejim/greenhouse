/**
 * Tables Schema Plan — the model drafts Base/table/field changes in chat.
 *
 * DRAFT-ONLY, exactly like `workflow_plan` and `mission_dispatch`: it creates
 * nothing and writes no row. It validates the plan and returns a
 * `tables_schema_plan` artifact the web renders as a card; the change is applied
 * only when the user presses Confirm on that card
 * (POST /api/tables/schema-plan/apply, reachable with the user's own bearer
 * token and absent from every model-facing tool table).
 *
 * The confirm gate is not ceremony. Record writes are individually visible in a
 * grid and trivially undone; a renamed field or an archived column changes the
 * shape of everyone's views at once and is much harder to notice after the
 * fact. So the model's autonomy stops at drafting (spec D2).
 *
 * Deliberately declares NO `surface`: schema editing stays off the Agent Proxy
 * and MCP, where no human is present to press anything (spec D3).
 *
 * The operation contract and its shape analysis live in
 * platform/tables/schema-plan.ts, shared verbatim with the apply route.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { SchemaPlanOperation, TableBaseRole, TablesSchemaPlanArtifact } from '@greenhouse/types/tables';
import { defineTool, type ToolMeta } from './define.js';
import { dispatchTablesAgentAction } from '../platform/tables/agent-adapter.js';
import {
  analyzeSchemaPlan,
  schemaPlanOperationSchema,
  MAX_SCHEMA_PLAN_OPERATIONS,
  SCHEMA_PLAN_ROLE_RANK,
  type SchemaPlanShape,
} from '../platform/tables/schema-plan.js';

const schemaPlanSchema = z.object({
  summary: z.string().min(1).max(500).describe("One line describing the change, in the user's language."),
  operations: z.array(schemaPlanOperationSchema).min(1).max(MAX_SCHEMA_PLAN_OPERATIONS).describe('Applied in order.'),
});

type SchemaPlanInput = z.infer<typeof schemaPlanSchema>;

// ─── Permission probe ────────────────────────────────────

interface ProbedTable {
  baseId: number;
  fieldIds: Set<number>;
}

function readSchemaResult(data: unknown): ProbedTable | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const { table, fields } = data as { table?: { base_id?: unknown }; fields?: unknown };
  if (!table || typeof table.base_id !== 'number') return undefined;
  const fieldIds = new Set<number>();
  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (field && typeof field === 'object' && typeof (field as { id?: unknown }).id === 'number') {
        fieldIds.add((field as { id: number }).id);
      }
    }
  }
  return { baseId: table.base_id, fieldIds };
}

function readBaseRole(data: unknown): TableBaseRole | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const role = (data as { role?: unknown }).role;
  return typeof role === 'string' && role in SCHEMA_PLAN_ROLE_RANK ? (role as TableBaseRole) : undefined;
}

export interface TablesSchemaPlanContext {
  userId: string;
}

/**
 * Resolves every existing object the plan names and checks the drafting user
 * really holds the role each operation needs. A plan that would fail on apply
 * must fail here instead — handing the user a card whose Confirm is guaranteed
 * to 404 wastes their turn and teaches the model nothing.
 *
 * Uses only read actions that already exist, so this adds no second
 * authorization path: the apply route re-checks everything per operation.
 */
async function probePermissions(userId: string, shape: SchemaPlanShape): Promise<string | undefined> {
  const context = { userId };
  const tables = new Map<number, ProbedTable>();

  for (const [tableId, required] of shape.tableRequirements) {
    const result = await dispatchTablesAgentAction(context, 'getSchema', { tableId }, { tableId });
    if (!result.ok) return `table ${tableId} was not found, or you cannot see it`;
    const probed = readSchemaResult(result.data);
    if (!probed) return `table ${tableId} returned an unreadable schema`;
    tables.set(tableId, probed);
    const current = shape.baseRequirements.get(probed.baseId);
    const merged = current && SCHEMA_PLAN_ROLE_RANK[current] > SCHEMA_PLAN_ROLE_RANK[required] ? current : required;
    shape.baseRequirements.set(probed.baseId, merged);
  }

  for (const [baseId, required] of shape.baseRequirements) {
    const result = await dispatchTablesAgentAction(context, 'getBase', { baseId }, { baseId });
    if (!result.ok) return `Base ${baseId} was not found, or you cannot see it`;
    const role = readBaseRole(result.data);
    if (!role) return `Base ${baseId} returned an unreadable role`;
    if (SCHEMA_PLAN_ROLE_RANK[role] < SCHEMA_PLAN_ROLE_RANK[required]) {
      return required === 'owner'
        ? `only the creator of Base ${baseId} can change its settings — your role there is "${role}"`
        : `changing the structure of Base ${baseId} needs the builder role — yours is "${role}"`;
    }
  }

  for (const target of shape.fieldTargets) {
    if (!tables.get(target.tableId)?.fieldIds.has(target.fieldId)) {
      return `field ${target.fieldId} is not an active field of table ${target.tableId} — re-read the schema`;
    }
  }

  return undefined;
}

// ─── Tool ────────────────────────────────────────────────

const meta: ToolMeta = {
  id: 'tables_schema_plan',
  name: 'Tables Schema Plan',
  brief: 'Draft Base, table and field changes for the user to confirm',
  description: `Draft a structural change to internal Tables — new Bases, tables, or fields — as a card the user confirms.

NOTHING is created until they press Confirm. Never say a table exists, or cite its id, in the turn you drafted it.

To touch anything existing, read it first with tables_query (bases.list → tables.list → schema.get); every id must come from there, never from memory.

Creating a Base also creates one table: name it with defaultTableName + defaultTableRef and put your fields in it, or you strand an empty "Table 1". Every new table already has a required primary text field "Name" and a Grid view — don't add your own title field.

ALWAYS describe a new Base/table (what it holds, who owns it, field conventions), and refresh that description in the same plan when a change alters what the table is for.

formula config takes an AST, not a string: {type:"literal",value} | {type:"field",fieldId} | {type:"binary",operator,left,right} with operator add/subtract/multiply/divide/concat/eq/neq/gt/gte/lt/lte/and/or | {type:"function",name,args} with name if/coalesce/concat/round/upper/lower.

CANNOT do — never promise it: change a field's TYPE (add a new field instead), delete a table or Base (the user does that in the sidebar: right-click → Delete, creator only, archived so an admin can restore it), or share one. Records are tables_mutation's job. Structure needs the builder role and Base settings the creator's; you are told when the user lacks it.`,
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
        const operations = input.operations as SchemaPlanOperation[];
        const shape = analyzeSchemaPlan(operations);
        if ('error' in shape) return { error: shape.error };

        const denied = await probePermissions(ctx.userId, shape);
        if (denied) return { error: denied };

        const artifact: TablesSchemaPlanArtifact = {
          type: 'tables_schema_plan',
          summary: input.summary.trim(),
          operations,
        };
        return artifact;
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

export const tablesSchemaPlanTool = defineTool({ meta, kind: 'lazy' });
