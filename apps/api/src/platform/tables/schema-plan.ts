/**
 * Applies a confirmed Tables schema plan, one operation at a time.
 *
 * Every operation goes through the SAME runtime action the Web UI uses, so
 * capability, entity policy and Base role are evaluated exactly once, in one
 * place. This module only sequences them and resolves plan-local refs.
 *
 * Deliberately NOT atomic (spec D5): a cross-action transaction would have to
 * bypass runtime.dispatch and re-implement authorization, which is the one
 * thing the Platform Kernel exists to prevent. Schema operations are additive
 * and individually reversible, so a partially applied plan is a visible,
 * fixable state — and every operation reports its own outcome.
 */

import { z } from 'zod';
import type { PlatformActionResult } from '@greenhouse/platform-kernel';
import {
  TABLE_FIELD_TYPES,
  type SchemaPlanApplyResult,
  type SchemaPlanOperation,
  type SchemaPlanOperationResult,
  type TableBaseRole,
} from '@greenhouse/types/tables';
import type { tablesResource, TablesActionId } from './application.js';

/** Enough for a whole Base in one card; far past it the user cannot review what they are confirming. */
export const MAX_SCHEMA_PLAN_OPERATIONS = 50;

export const SCHEMA_PLAN_ROLE_RANK: Record<TableBaseRole, number> = {
  viewer: 0,
  editor: 1,
  builder: 2,
  owner: 3,
};

// ─── Wire schema (shared by the chat tool and the apply route) ───

const refSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'A ref may contain only letters, numbers, _ or -');

const selectOptionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .describe('Stable option id stored in every record. Letters, numbers, _ or - ONLY — never Chinese.'),
  label: z.string().min(1).max(100).describe('Display label. Any language.'),
  color: z.string().max(32).optional().describe('Optional hex color.'),
});

const fieldConfigSchema = z.object({
  options: z.array(selectOptionSchema).max(100).optional().describe('Choices for single_select / multi_select.'),
  relation: z
    .object({
      targetTableId: z.number().int().positive().describe('Linked table. Must be in the SAME Base.'),
      multiple: z.boolean().optional().describe('Allow linking several records.'),
    })
    .optional(),
  formula: z
    .object({
      resultType: z.enum(['text', 'number', 'boolean', 'date', 'datetime']),
      expression: z.unknown().describe('Formula AST — see the tool description for its shape.'),
    })
    .optional(),
  rollup: z
    .object({
      relationFieldId: z.number().int().positive().describe('A relation field in THIS table.'),
      targetFieldId: z.number().int().positive().describe('A field in the related table.'),
      aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max', 'join']),
    })
    .optional(),
});

export const schemaPlanOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('base.create'),
    ref: refSchema.describe('Plan-local name for this new Base, referenced by later operations.'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    visibility: z
      .enum(['private', 'team'])
      .optional()
      .describe('private (invited members only, default) or team (every internal user can view).'),
    defaultTableRef: refSchema
      .optional()
      .describe('Plan-local name for the table created alongside the Base. Give one to put fields in it.'),
    defaultTableName: z.string().min(1).max(200).optional().describe('Name for that table. Defaults to "Table 1".'),
  }),
  z.object({
    op: z.literal('base.update'),
    baseId: z.number().int().positive(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    visibility: z.enum(['private', 'team']).optional(),
  }),
  z.object({
    op: z.literal('table.create'),
    ref: refSchema.optional().describe('Plan-local name, needed only if later operations add fields to it.'),
    baseRef: refSchema.optional().describe('A Base this plan creates. Exactly one of baseRef / baseId.'),
    baseId: z.number().int().positive().optional().describe('An existing Base. Exactly one of baseRef / baseId.'),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
  }),
  z.object({
    op: z.literal('table.update'),
    tableId: z.number().int().positive(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
  }),
  z.object({
    op: z.literal('field.create'),
    tableRef: refSchema.optional().describe('A table this plan creates. Exactly one of tableRef / tableId.'),
    tableId: z.number().int().positive().optional().describe('An existing table. Exactly one of tableRef / tableId.'),
    name: z.string().min(1).max(200),
    type: z.enum(TABLE_FIELD_TYPES),
    required: z.boolean().optional(),
    config: fieldConfigSchema
      .optional()
      .describe('Required for single_select, multi_select, relation, formula, rollup.'),
  }),
  z.object({
    op: z.literal('field.update'),
    tableId: z.number().int().positive().describe('The table this field belongs to.'),
    fieldId: z.number().int().positive(),
    name: z.string().min(1).max(200).optional(),
    required: z.boolean().optional(),
    config: fieldConfigSchema.optional().describe('Replaces the whole config — resend every select option you keep.'),
  }),
  z.object({
    op: z.literal('field.archive'),
    tableId: z.number().int().positive().describe('The table this field belongs to.'),
    fieldId: z.number().int().positive(),
  }),
]);

export const schemaPlanApplySchema = z.object({
  operations: z.array(schemaPlanOperationSchema).min(1).max(MAX_SCHEMA_PLAN_OPERATIONS),
});

// ─── Shape analysis (pure) ───────────────────────────────

export interface SchemaPlanShape {
  /** Existing Base ids the plan touches → the role it needs on each. */
  baseRequirements: Map<number, TableBaseRole>;
  /** Existing table ids the plan touches → the role it needs on their Base. */
  tableRequirements: Map<number, TableBaseRole>;
  /** field.update / field.archive targets, checked against their table's real schema. */
  fieldTargets: Array<{ tableId: number; fieldId: number }>;
}

function raise(role: TableBaseRole, current: TableBaseRole | undefined): TableBaseRole {
  return current && SCHEMA_PLAN_ROLE_RANK[current] > SCHEMA_PLAN_ROLE_RANK[role] ? current : role;
}

/**
 * Checks everything about a plan that can be decided without touching the
 * database: ref declaration order (which also rules out cycles), the
 * ref-or-id exclusive choices, and which existing objects need a permission
 * probe. Field values, select option shapes and formula ASTs are NOT checked
 * here — the runtime validates those on apply and returns readable errors.
 */
export function analyzeSchemaPlan(operations: SchemaPlanOperation[]): { error: string } | SchemaPlanShape {
  const baseRefs = new Set<string>();
  const tableRefs = new Set<string>();
  const shape: SchemaPlanShape = {
    baseRequirements: new Map(),
    tableRequirements: new Map(),
    fieldTargets: [],
  };

  const declare = (ref: string, into: Set<string>, at: number): string | undefined => {
    if (baseRefs.has(ref) || tableRefs.has(ref)) return `operation ${at + 1}: ref "${ref}" is already used`;
    into.add(ref);
    return undefined;
  };

  for (const [index, operation] of operations.entries()) {
    const at = index + 1;
    switch (operation.op) {
      case 'base.create': {
        const clash = declare(operation.ref, baseRefs, index);
        if (clash) return { error: clash };
        if (operation.defaultTableRef) {
          const tableClash = declare(operation.defaultTableRef, tableRefs, index);
          if (tableClash) return { error: tableClash };
        }
        break;
      }
      case 'base.update':
        shape.baseRequirements.set(operation.baseId, raise('owner', shape.baseRequirements.get(operation.baseId)));
        break;
      case 'table.create': {
        if ((operation.baseRef === undefined) === (operation.baseId === undefined)) {
          return { error: `operation ${at}: give exactly one of baseRef or baseId` };
        }
        if (operation.baseRef !== undefined && !baseRefs.has(operation.baseRef)) {
          return { error: `operation ${at}: no Base with ref "${operation.baseRef}" is created earlier in this plan` };
        }
        if (operation.baseId !== undefined) {
          shape.baseRequirements.set(operation.baseId, raise('builder', shape.baseRequirements.get(operation.baseId)));
        }
        if (operation.ref) {
          const clash = declare(operation.ref, tableRefs, index);
          if (clash) return { error: clash };
        }
        break;
      }
      case 'table.update':
        shape.tableRequirements.set(
          operation.tableId,
          raise('builder', shape.tableRequirements.get(operation.tableId)),
        );
        break;
      case 'field.create': {
        if ((operation.tableRef === undefined) === (operation.tableId === undefined)) {
          return { error: `operation ${at}: give exactly one of tableRef or tableId` };
        }
        if (operation.tableRef !== undefined && !tableRefs.has(operation.tableRef)) {
          return {
            error: `operation ${at}: no table with ref "${operation.tableRef}" is created earlier in this plan`,
          };
        }
        if (operation.tableId !== undefined) {
          shape.tableRequirements.set(
            operation.tableId,
            raise('builder', shape.tableRequirements.get(operation.tableId)),
          );
        }
        break;
      }
      case 'field.update':
      case 'field.archive':
        shape.tableRequirements.set(
          operation.tableId,
          raise('builder', shape.tableRequirements.get(operation.tableId)),
        );
        shape.fieldTargets.push({ tableId: operation.tableId, fieldId: operation.fieldId });
        break;
    }
  }

  return shape;
}

export type SchemaPlanDispatch = (
  actionId: TablesActionId,
  payload: unknown,
  ids: Parameters<typeof tablesResource>[1],
) => Promise<PlatformActionResult>;

/** Reads `data.base.id`, `data.table.id`, `data.field.id` … without trusting the shape. */
function nestedId(data: unknown, key: string): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const nested = (data as Record<string, unknown>)[key];
  if (!nested || typeof nested !== 'object') return undefined;
  const id = (nested as { id?: unknown }).id;
  return typeof id === 'number' ? id : undefined;
}

export async function applySchemaPlan(
  operations: SchemaPlanOperation[],
  dispatch: SchemaPlanDispatch,
): Promise<SchemaPlanApplyResult> {
  const baseIds = new Map<string, number>();
  const tableIds = new Map<string, number>();
  /** Refs whose object was never created, so anything hanging off them is skipped rather than misapplied. */
  const unresolved = new Map<string, string>();
  const results: SchemaPlanOperationResult[] = [];
  const touchedBases = new Set<number>();

  for (const [index, operation] of operations.entries()) {
    const skip = (message: string) => results.push({ index, op: operation.op, status: 'skipped', message });
    const fail = (message: string) => results.push({ index, op: operation.op, status: 'failed', message });
    const applied = (id?: number) =>
      results.push({ index, op: operation.op, status: 'applied', ...(id === undefined ? {} : { id }) });

    switch (operation.op) {
      case 'base.create': {
        const result = await dispatch(
          'createBase',
          {
            name: operation.name,
            description: operation.description,
            visibility: operation.visibility ?? 'private',
            defaultTableName: operation.defaultTableName,
          },
          {},
        );
        if (!result.ok) {
          fail(result.message);
          unresolved.set(operation.ref, result.message);
          if (operation.defaultTableRef) unresolved.set(operation.defaultTableRef, result.message);
          break;
        }
        const baseId = nestedId(result.data, 'base');
        if (baseId !== undefined) {
          baseIds.set(operation.ref, baseId);
          touchedBases.add(baseId);
        }
        // createBase always makes one table; expose it so later fields can target it.
        const defaultTableId = nestedId((result.data as { schema?: unknown } | undefined)?.schema, 'table');
        if (operation.defaultTableRef && defaultTableId !== undefined) {
          tableIds.set(operation.defaultTableRef, defaultTableId);
        }
        applied(baseId);
        break;
      }

      case 'base.update': {
        const result = await dispatch(
          'updateBase',
          {
            baseId: operation.baseId,
            name: operation.name,
            description: operation.description,
            visibility: operation.visibility,
          },
          { baseId: operation.baseId },
        );
        if (!result.ok) fail(result.message);
        else {
          touchedBases.add(operation.baseId);
          applied(operation.baseId);
        }
        break;
      }

      case 'table.create': {
        let baseId = operation.baseId;
        if (operation.baseRef !== undefined) {
          const reason = unresolved.get(operation.baseRef);
          if (reason) {
            skip(`the Base "${operation.baseRef}" was not created: ${reason}`);
            if (operation.ref) unresolved.set(operation.ref, reason);
            break;
          }
          baseId = baseIds.get(operation.baseRef);
        }
        if (baseId === undefined) {
          const reason = `no Base resolved for "${operation.baseRef ?? operation.baseId}"`;
          fail(reason);
          if (operation.ref) unresolved.set(operation.ref, reason);
          break;
        }
        const result = await dispatch(
          'createTable',
          { baseId, name: operation.name, description: operation.description },
          { baseId },
        );
        if (!result.ok) {
          fail(result.message);
          if (operation.ref) unresolved.set(operation.ref, result.message);
          break;
        }
        touchedBases.add(baseId);
        const tableId = nestedId(result.data, 'table');
        if (operation.ref && tableId !== undefined) tableIds.set(operation.ref, tableId);
        applied(tableId);
        break;
      }

      case 'table.update': {
        const result = await dispatch(
          'updateTable',
          { tableId: operation.tableId, name: operation.name, description: operation.description },
          { tableId: operation.tableId },
        );
        if (!result.ok) fail(result.message);
        else applied(operation.tableId);
        break;
      }

      case 'field.create': {
        let tableId = operation.tableId;
        if (operation.tableRef !== undefined) {
          const reason = unresolved.get(operation.tableRef);
          if (reason) {
            skip(`the table "${operation.tableRef}" was not created: ${reason}`);
            break;
          }
          tableId = tableIds.get(operation.tableRef);
        }
        if (tableId === undefined) {
          fail(`no table resolved for "${operation.tableRef ?? operation.tableId}"`);
          break;
        }
        const result = await dispatch(
          'createField',
          {
            tableId,
            name: operation.name,
            type: operation.type,
            required: operation.required === true,
            config: operation.config,
          },
          { tableId },
        );
        if (!result.ok) fail(result.message);
        else applied(nestedId(result.data, 'field'));
        break;
      }

      case 'field.update': {
        const result = await dispatch(
          'updateField',
          {
            fieldId: operation.fieldId,
            name: operation.name,
            required: operation.required,
            config: operation.config,
          },
          { fieldId: operation.fieldId },
        );
        if (!result.ok) fail(result.message);
        else applied(operation.fieldId);
        break;
      }

      case 'field.archive': {
        const result = await dispatch('archiveField', { fieldId: operation.fieldId }, { fieldId: operation.fieldId });
        if (!result.ok) fail(result.message);
        else applied(operation.fieldId);
        break;
      }
    }
  }

  // Only offer a "open the Base" link when the plan is unambiguously about one.
  const baseId = touchedBases.size === 1 ? [...touchedBases][0] : undefined;
  return { results, ...(baseId === undefined ? {} : { baseId }) };
}
