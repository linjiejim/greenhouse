import { z } from 'zod';
import {
  createFieldInputSchema,
  updateFieldInputSchema,
  updateTableInputSchema,
  roleAtLeast,
} from '@greenhouse/contract';
import { invalidInput, forbidden } from '../../http/errors.js';
import { transaction } from '@greenhouse/db';
import type { TablesService } from '../../modules/tables/service.js';
import { defineTool } from './define.js';

/** Exact plans live in approval cards; no schema is changed until the member confirms. */
export function tableSchemaTool(tables: TablesService) {
  return defineTool({
    name: 'table_schema_plan',
    description:
      'Plan a base and its data tables, or change existing schema, for the member to confirm. To create a base: omit base_id; name is the base name; tables lists the data tables, each with all its new fields nested in fields; leave changes empty. Example: {name: "Work", tables: [{name: "Items", fields: [{name: "Notes", type: "long_text"}]}], changes: []}. Newly created tables already have a primary name field. changes only targets existing ids read with table_query, never names or tables being created in this plan. Existing base requires builder access.',
    input: z.object({
      base_id: z.string().max(64).optional(),
      name: z.string().trim().min(1).max(100).describe('The new base name; for an existing base, the plan title.'),
      tables: z
        .array(z.object({ name: z.string().trim().min(1).max(100), fields: z.array(createFieldInputSchema).max(30) }))
        .max(10)
        .default([])
        .describe(
          'New data tables with ALL their new fields nested in fields. This creates each table and its fields together; no ids are needed.',
        ),
      changes: z
        .array(
          z.discriminatedUnion('action', [
            z.object({
              action: z.literal('create_field'),
              table_id: z.string().max(64),
              input: createFieldInputSchema,
            }),
            z.object({
              action: z.literal('update_field'),
              field_id: z.string().max(64),
              input: updateFieldInputSchema,
            }),
            z.object({ action: z.literal('archive_field'), field_id: z.string().max(64) }),
            z.object({
              action: z.literal('update_table'),
              table_id: z.string().max(64),
              input: updateTableInputSchema,
            }),
          ]),
        )
        .max(50)
        .default([])
        .describe(
          'Only changes to existing table/field ids in base_id. Empty when creating a new base. Never put table names here.',
        ),
    }),
    risk: 'write',
    available: (ctx) => ctx.modules.tables,
    async callRisk(args, ctx) {
      if (!args.base_id && args.changes.length)
        throw invalidInput(
          'For a new base, put every new field inside tables[].fields and leave changes empty. Existing ids do not exist yet.',
        );
      if (args.base_id) {
        const base = await tables.get(ctx.memberId, args.base_id);
        if (!roleAtLeast(base.access, 'builder')) throw forbidden('Builder access is required to plan schema changes.');
        for (const change of args.changes) {
          if (
            ('table_id' in change && !base.tables.some((t) => t.id === change.table_id)) ||
            ('field_id' in change && !base.tables.some((t) => t.fields.some((f) => f.id === change.field_id)))
          )
            throw invalidInput(
              'Schema changes need existing ids from table_query, inside this base; never use a table name as an id.',
            );
        }
      }
      return 'tier2';
    },
    describe: (args, ctx) => ({
      summary: ctx.locale === 'zh' ? '确认表格结构计划' : 'Confirm table structure plan',
      details: [{ label: args.name, value: JSON.stringify(args).slice(0, 4000) }],
    }),
    async execute(args, ctx) {
      return transaction(async () => {
        const base = args.base_id
          ? await tables.get(ctx.memberId, args.base_id)
          : await tables.create(ctx.memberId, { name: args.name });
        for (const [index, plan] of args.tables.entries()) {
          const table =
            !args.base_id && index === 0
              ? await tables.updateTable(ctx.memberId, base.tables[0]!.id, { name: plan.name })
              : await tables.createTable(ctx.memberId, base.id, plan.name);
          for (const field of plan.fields) await tables.createField(ctx.memberId, table.id, field);
        }
        for (const change of args.changes) {
          if (
            ('table_id' in change && !base.tables.some((t) => t.id === change.table_id)) ||
            ('field_id' in change && !base.tables.some((t) => t.fields.some((f) => f.id === change.field_id)))
          )
            throw invalidInput('Every schema target must be inside this base.');
          if (change.action === 'create_field') await tables.createField(ctx.memberId, change.table_id, change.input);
          if (change.action === 'update_field') await tables.updateField(ctx.memberId, change.field_id, change.input);
          if (change.action === 'archive_field') await tables.archiveField(ctx.memberId, change.field_id);
          if (change.action === 'update_table') await tables.updateTable(ctx.memberId, change.table_id, change.input);
        }
        return tables.get(ctx.memberId, base.id);
      });
    },
  });
}
