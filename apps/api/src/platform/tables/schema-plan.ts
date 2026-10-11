/**
 * Applies a confirmed Tables schema plan, one operation at a time.
 *
 * Every operation goes through the SAME runtime action the Web UI uses, so
 * capability, entity policy and Base role are evaluated exactly once, in one
 * place. This module only sequences them and resolves plan-local refs:
 * top-level `baseRef` / `tableRef` / `dashboardRef` / `roleRef`, and
 * `"$<kind>:<ref>"` tokens anywhere inside an op's config (`./schema-plan-refs.ts`).
 *
 * Deliberately NOT atomic (spec D5): a cross-action transaction would have to
 * bypass runtime.dispatch and re-implement authorization, which is the one
 * thing the Platform Kernel exists to prevent. Every operation reports its own
 * outcome; anything hanging off a ref whose object was never created is
 * skipped. The result carries the ref → id map, so "retry unfinished
 * operations" re-runs only what did not apply and reuses what did.
 *
 * Draft-time validation against a virtual schema lives in
 * `./schema-plan-draft.ts`; this file is pure of the database.
 */

import { z } from 'zod';
import type { PlatformActionResult } from '@greenhouse/platform-kernel';
import {
  TABLE_AUTOMATION_TRIGGERS,
  TABLE_FIELD_TYPES,
  TABLE_VIEW_TYPES,
  type SchemaPlanApplyResult,
  type SchemaPlanObjectKind,
  type SchemaPlanOperation,
  type SchemaPlanOperationResult,
  type SchemaPlanRef,
  type SchemaPlanRefMap,
} from '@greenhouse/types/tables';
import type { TablesActionId } from '../manifests/tables.js';
import type { TablesResourceIds } from './audit.js';
import { collectRefTokens, resolveRefTokens, UnresolvedRefError } from './schema-plan-refs.js';

/** Enough for a whole Base in one card; far past it the user cannot review what they are confirming. */
export const MAX_SCHEMA_PLAN_OPERATIONS = 50;

// ─── Wire schema (shared by the chat tool and the apply route) ───

const refSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'A ref may contain only letters, numbers, _ or -');

const idSchema = z.number().int().positive();
const tokenSchema = (kind: 'field' | 'table') =>
  z.string().regex(new RegExp(`^\\$${kind}:[A-Za-z0-9_-]{1,64}$`), `an id or "$${kind}:<ref>"`);
const fieldIdSchema = z.union([idSchema, tokenSchema('field')]);

const selectOptionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .describe('Stable option id stored in every record. Letters, numbers, _ or - ONLY — never Chinese.'),
  label: z.string().min(1).max(100).describe('Display label. Any language.'),
  color: z.string().max(32).optional(),
});

const fieldConfigSchema = z.object({
  options: z.array(selectOptionSchema).max(100).optional().describe('Choices for single_select / multi_select.'),
  relation: z
    .object({
      targetTableId: z.union([idSchema, tokenSchema('table')]).describe('Linked table in the SAME Base.'),
      multiple: z.boolean().optional(),
    })
    .optional(),
  formula: z
    .object({
      resultType: z.enum(['text', 'number', 'boolean', 'date', 'datetime']),
      expression: z.unknown().describe('Formula AST — see the tool description.'),
    })
    .optional(),
  rollup: z
    .object({
      relationFieldId: fieldIdSchema.describe('A relation field of THIS table.'),
      targetFieldId: fieldIdSchema.describe('A field of the related table.'),
      aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max', 'join']),
    })
    .optional(),
  lookup: z.object({ relationFieldId: fieldIdSchema, targetFieldId: fieldIdSchema }).optional(),
});

/** Config JSON checked by the real handler; may hold `$<kind>:<ref>` tokens. */
const configSchema = z.record(z.string(), z.unknown());

const layoutSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(24),
  h: z.number().int().min(1).max(24),
});

const audienceSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('base') }),
    z.object({ type: z.literal('team') }),
    z.object({
      type: z.literal('principals'),
      userIds: z.array(z.string().min(1).max(128)).max(500).optional(),
      groupIds: z.array(idSchema).max(100).optional(),
    }),
  ])
  .describe('Who may submit: base (members who can create), team (every internal user), or principals.');

const description = z.string().max(2000);
const revision = idSchema.describe('The revision you read; a stale one fails instead of overwriting.');
const READ_GRAMMAR = 'See tables_query builder.reference for the grammar.';

export const schemaPlanOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('base.create'),
    ref: refSchema.describe('Plan-local name for this new Base, referenced by later operations.'),
    name: z.string().min(1).max(200),
    description: description.optional(),
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
    baseId: idSchema.optional(),
    baseRef: refSchema.optional(),
    name: z.string().min(1).max(200).optional(),
    description: description.nullable().optional(),
    visibility: z.enum(['private', 'team']).optional(),
    teamRole: z.enum(['viewer', 'editor', 'custom']).optional().describe('What everyone gets on a team Base.'),
    roleRef: refSchema.optional(),
    teamCustomRoleId: idSchema.optional(),
  }),
  z.object({
    op: z.literal('table.create'),
    ref: refSchema.optional(),
    baseRef: refSchema.optional(),
    baseId: idSchema.optional(),
    name: z.string().min(1).max(200),
    description: description.optional(),
  }),
  z.object({
    op: z.literal('table.update'),
    tableId: idSchema,
    name: z.string().min(1).max(200).optional(),
    description: description.nullable().optional(),
  }),
  z.object({
    op: z.literal('field.create'),
    ref: refSchema.optional(),
    tableRef: refSchema.optional(),
    tableId: idSchema.optional(),
    name: z.string().min(1).max(200),
    type: z.enum(TABLE_FIELD_TYPES),
    required: z.boolean().optional(),
    config: fieldConfigSchema
      .optional()
      .describe('Required for single_select, multi_select, relation, formula, rollup, lookup.'),
  }),
  z.object({
    op: z.literal('field.update'),
    tableId: idSchema.describe('The table this field belongs to.'),
    fieldId: idSchema,
    name: z.string().min(1).max(200).optional(),
    required: z.boolean().optional(),
    config: fieldConfigSchema.optional().describe('Replaces the whole config — resend every select option you keep.'),
  }),
  z.object({
    op: z.literal('field.archive'),
    tableId: idSchema.describe('The table this field belongs to.'),
    fieldId: idSchema,
  }),
  z.object({
    op: z.literal('view.create'),
    ref: refSchema.optional(),
    tableRef: refSchema.optional(),
    tableId: idSchema.optional(),
    name: z.string().min(1).max(120),
    type: z.enum(TABLE_VIEW_TYPES).optional(),
    scope: z.enum(['shared', 'personal']).optional().describe('Default shared.'),
    config: configSchema.optional().describe(`TableViewConfig. ${READ_GRAMMAR}`),
  }),
  z.object({
    op: z.literal('view.update'),
    tableId: idSchema,
    viewId: idSchema,
    revision,
    name: z.string().min(1).max(120).optional(),
    type: z.enum(TABLE_VIEW_TYPES).optional(),
    config: configSchema.optional().describe('Replaces the whole config.'),
  }),
  z.object({
    op: z.literal('form.create'),
    ref: refSchema.optional(),
    tableRef: refSchema.optional(),
    tableId: idSchema.optional(),
    name: z.string().min(1).max(120),
    status: z.enum(['draft', 'published']).optional().describe('Default draft; only published forms open.'),
    audience: audienceSchema.optional(),
    config: configSchema.describe(`TableFormConfig. ${READ_GRAMMAR}`),
  }),
  z.object({
    op: z.literal('form.update'),
    formId: idSchema,
    revision,
    name: z.string().min(1).max(120).optional(),
    status: z.enum(['draft', 'published']).optional(),
    audience: audienceSchema.optional(),
    config: configSchema.optional(),
  }),
  z.strictObject({
    op: z.literal('automation.create'),
    ref: refSchema.optional(),
    tableRef: refSchema.optional(),
    tableId: idSchema.optional(),
    name: z.string().min(1).max(120),
    trigger: z.enum(TABLE_AUTOMATION_TRIGGERS),
    status: z.enum(['disabled', 'enabled']).optional().describe('Default disabled.'),
    config: configSchema.describe(`TableAutomationConfig, no webhook actions. ${READ_GRAMMAR}`),
  }),
  z.strictObject({
    op: z.literal('automation.update'),
    tableId: idSchema,
    automationId: idSchema,
    revision,
    name: z.string().min(1).max(120).optional(),
    trigger: z.enum(TABLE_AUTOMATION_TRIGGERS).optional(),
    status: z.enum(['disabled', 'enabled']).optional(),
    config: configSchema.optional().describe('Replaces the whole config.'),
  }),
  z.object({
    op: z.literal('dashboard.create'),
    ref: refSchema.optional(),
    baseRef: refSchema.optional(),
    baseId: idSchema.optional(),
    name: z.string().min(1).max(120),
    description: description.optional(),
    config: configSchema.optional().describe('{version:1, filters:[…]}.'),
  }),
  z.object({
    op: z.literal('dashboard.update'),
    dashboardId: idSchema,
    revision,
    name: z.string().min(1).max(120).optional(),
    description: description.nullable().optional(),
    config: configSchema.optional(),
  }),
  z.object({
    op: z.literal('widget.create'),
    ref: refSchema.optional(),
    dashboardRef: refSchema.optional(),
    dashboardId: idSchema.optional(),
    title: z.string().min(1).max(120),
    card: configSchema.describe(`TableCardSpec. ${READ_GRAMMAR}`),
    layout: layoutSchema.optional(),
  }),
  z.object({
    op: z.literal('widget.update'),
    dashboardId: idSchema,
    widgetId: idSchema,
    revision,
    title: z.string().min(1).max(120).optional(),
    card: configSchema.optional(),
    layout: layoutSchema.optional(),
  }),
  z.object({ op: z.literal('widget.delete'), dashboardId: idSchema, widgetId: idSchema }),
  z.object({
    op: z.literal('role.create'),
    ref: refSchema.optional(),
    baseRef: refSchema.optional(),
    baseId: idSchema.optional(),
    name: z.string().min(1).max(60),
    description: description.optional(),
    rules: configSchema.describe(`TableAccessRules. ${READ_GRAMMAR}`),
  }),
  z.object({
    op: z.literal('role.update'),
    baseId: idSchema,
    roleId: idSchema,
    revision,
    name: z.string().min(1).max(60).optional(),
    description: description.nullable().optional(),
    rules: configSchema.optional(),
  }),
  z.object({
    op: z.literal('member.set'),
    baseRef: refSchema.optional(),
    baseId: idSchema.optional(),
    principal: z.enum(['user', 'group']),
    userId: z.string().min(1).max(128).optional(),
    groupId: idSchema.optional(),
    role: z
      .enum(['builder', 'editor', 'viewer', 'custom', 'none'])
      .describe('none removes the grant; a group is never builder.'),
    roleRef: refSchema.optional(),
    customRoleId: idSchema.optional(),
  }),
]);

/** The zod schema and the shared TS type describe the same thing — checked here, at compile time. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type SchemaPlanOperationContract = Assert<Equal<z.infer<typeof schemaPlanOperationSchema>, SchemaPlanOperation>>;

export const schemaPlanApplySchema = z.object({
  operations: z.array(schemaPlanOperationSchema).min(1).max(MAX_SCHEMA_PLAN_OPERATIONS),
  /** Re-run only the operations of an applied plan that did not apply, reusing its ref map. */
  retry: z.boolean().optional(),
});

// ─── Shape analysis (pure) ───────────────────────────────

/** A ref an operation needs: a top-level `*Ref`, or a `$<kind>:<ref>` token in its config. */
export interface SchemaPlanRefNeed {
  kind: SchemaPlanObjectKind;
  ref: SchemaPlanRef;
}

export interface SchemaPlanShape {
  /** Every ref the plan declares: its kind and the operation that creates it. */
  declared: Map<SchemaPlanRef, { kind: SchemaPlanObjectKind; index: number }>;
  /** Per operation, the refs it needs (all declared by an earlier operation). */
  needs: SchemaPlanRefNeed[][];
}

/** The refs each operation declares, in the order it creates them. */
export function declaredRefs(
  operation: SchemaPlanOperation,
): Array<{ ref: SchemaPlanRef; kind: SchemaPlanObjectKind }> {
  switch (operation.op) {
    case 'base.create':
      return [
        { ref: operation.ref, kind: 'base' },
        ...(operation.defaultTableRef ? [{ ref: operation.defaultTableRef, kind: 'table' as const }] : []),
      ];
    case 'table.create':
    case 'field.create':
    case 'view.create':
    case 'form.create':
    case 'automation.create':
    case 'dashboard.create':
    case 'widget.create':
    case 'role.create': {
      const kind = operation.op.slice(0, operation.op.indexOf('.')) as SchemaPlanObjectKind;
      return operation.ref ? [{ ref: operation.ref, kind }] : [];
    }
    default:
      return [];
  }
}

/** The config-bearing parts of an op, where `$<kind>:<ref>` tokens may appear. */
function tokenScope(operation: SchemaPlanOperation): unknown[] {
  switch (operation.op) {
    case 'field.create':
    case 'field.update':
    case 'view.create':
    case 'view.update':
    case 'form.create':
    case 'form.update':
    case 'automation.create':
    case 'automation.update':
    case 'dashboard.create':
    case 'dashboard.update':
      return [operation.config];
    case 'widget.create':
    case 'widget.update':
      return [operation.card];
    case 'role.create':
    case 'role.update':
      return [operation.rules];
    default:
      return [];
  }
}

function exactlyOne(at: number, a: unknown, b: unknown, names: string): string | undefined {
  return (a === undefined) === (b === undefined) ? `operation ${at}: give exactly one of ${names}` : undefined;
}

/** Automation configs from a plan: no webhooks to new places, no secrets, no executor (D16, D17). */
function automationProblem(at: number, operation: SchemaPlanOperation): string | undefined {
  if (operation.op !== 'automation.create' && operation.op !== 'automation.update') return undefined;
  const config = operation.config;
  if (!config) return undefined;
  const hasKey = (node: unknown, keys: readonly string[]): boolean =>
    Array.isArray(node)
      ? node.some((child) => hasKey(child, keys))
      : !!node &&
        typeof node === 'object' &&
        Object.entries(node).some(([key, child]) => keys.includes(key) || hasKey(child, keys));
  if (hasKey(config, ['executionUserId', 'execution_user_id'])) {
    return `operation ${at}: the executor is whoever confirms the plan; remove executionUserId`;
  }
  const actions = Array.isArray(config.actions) ? (config.actions as unknown[]) : [];
  for (const action of actions) {
    if (!action || typeof action !== 'object' || (action as { type?: unknown }).type !== 'webhook') continue;
    const webhook = action as { id?: unknown; secret?: unknown };
    // A plan may keep a webhook the rule already has (same id, URL and fields — checked against the
    // stored rule when drafting) but never add one: webhooks are built by a person in the editor.
    if (operation.op === 'automation.create' || typeof webhook.id !== 'string' || 'secret' in webhook) {
      return `operation ${at}: webhook actions can only be added in the Tables editor, not in a plan`;
    }
  }
  return undefined;
}

/**
 * Checks everything about a plan that can be decided without touching the
 * database: ref declaration order (which also rules out cycles), ref kinds,
 * the ref-or-id exclusive choices, member / team-role shapes, and that no
 * automation adds a webhook or names an executor. Configs themselves are
 * checked by `draftSchemaPlan` against a virtual schema, and again by every
 * handler on apply.
 */
export function analyzeSchemaPlan(operations: SchemaPlanOperation[]): { error: string } | SchemaPlanShape {
  const declared = new Map<SchemaPlanRef, { kind: SchemaPlanObjectKind; index: number; base?: string }>();
  const needs: SchemaPlanRefNeed[][] = [];

  /** Where a base-scoped object lives: `ref:<baseRef>` or `id:<baseId>`. */
  const baseKey = (baseRef: string | undefined, baseId: number | undefined) =>
    baseRef !== undefined ? `ref:${baseRef}` : baseId !== undefined ? `id:${baseId}` : undefined;

  for (const [index, operation] of operations.entries()) {
    const at = index + 1;
    const opNeeds: SchemaPlanRefNeed[] = [];
    const need = (kind: SchemaPlanObjectKind, ref: string | undefined): string | undefined => {
      if (ref === undefined) return undefined;
      const found = declared.get(ref);
      if (!found) return `operation ${at}: no ${kind} with ref "${ref}" is created earlier in this plan`;
      if (found.kind !== kind) return `operation ${at}: ref "${ref}" is a ${found.kind}, not a ${kind}`;
      opNeeds.push({ kind, ref });
      return undefined;
    };

    let problem: string | undefined;
    switch (operation.op) {
      case 'base.create':
        break;
      case 'base.update':
        problem =
          exactlyOne(at, operation.baseId, operation.baseRef, 'baseId or baseRef') ?? need('base', operation.baseRef);
        if (!problem && operation.teamRole === 'custom') {
          problem =
            exactlyOne(at, operation.roleRef, operation.teamCustomRoleId, 'roleRef or teamCustomRoleId') ??
            need('role', operation.roleRef);
          const role = operation.roleRef ? declared.get(operation.roleRef) : undefined;
          if (!problem && role?.base !== undefined && role.base !== baseKey(operation.baseRef, operation.baseId)) {
            problem = `operation ${at}: role "${operation.roleRef}" belongs to another Base`;
          }
        } else if (!problem && (operation.roleRef !== undefined || operation.teamCustomRoleId !== undefined)) {
          problem = `operation ${at}: a team role is named only with teamRole "custom"`;
        }
        break;
      case 'table.create':
      case 'dashboard.create':
      case 'role.create':
        problem =
          exactlyOne(at, operation.baseRef, operation.baseId, 'baseRef or baseId') ?? need('base', operation.baseRef);
        break;
      case 'field.create':
      case 'view.create':
      case 'form.create':
      case 'automation.create':
        problem =
          exactlyOne(at, operation.tableRef, operation.tableId, 'tableRef or tableId') ??
          need('table', operation.tableRef);
        break;
      case 'widget.create':
        problem =
          exactlyOne(at, operation.dashboardRef, operation.dashboardId, 'dashboardRef or dashboardId') ??
          need('dashboard', operation.dashboardRef);
        break;
      case 'member.set': {
        problem =
          exactlyOne(at, operation.baseRef, operation.baseId, 'baseRef or baseId') ?? need('base', operation.baseRef);
        if (problem) break;
        if (operation.principal === 'user' && (operation.userId === undefined || operation.groupId !== undefined)) {
          problem = `operation ${at}: a user grant names userId (and no groupId)`;
        } else if (
          operation.principal === 'group' &&
          (operation.groupId === undefined || operation.userId !== undefined)
        ) {
          problem = `operation ${at}: a group grant names groupId (and no userId)`;
        } else if (operation.principal === 'group' && operation.role === 'builder') {
          problem = `operation ${at}: a group can be editor, viewer or custom — builder is granted to people only`;
        } else if (operation.role === 'custom') {
          problem =
            exactlyOne(at, operation.roleRef, operation.customRoleId, 'roleRef or customRoleId') ??
            need('role', operation.roleRef);
          const role = operation.roleRef ? declared.get(operation.roleRef) : undefined;
          if (!problem && role?.base !== undefined && role.base !== baseKey(operation.baseRef, operation.baseId)) {
            problem = `operation ${at}: role "${operation.roleRef}" belongs to another Base`;
          }
        } else if (operation.roleRef !== undefined || operation.customRoleId !== undefined) {
          problem = `operation ${at}: a role is named only with role "custom"`;
        }
        break;
      }
      default:
        break;
    }
    problem ??= automationProblem(at, operation);
    if (problem) return { error: problem };

    for (const scope of tokenScope(operation)) {
      for (const use of collectRefTokens(scope)) {
        const problemWithToken = need(use.kind, use.ref);
        if (problemWithToken) return { error: problemWithToken };
      }
    }

    for (const declaration of declaredRefs(operation)) {
      if (declared.has(declaration.ref)) return { error: `operation ${at}: ref "${declaration.ref}" is already used` };
      const base = operation.op === 'role.create' ? baseKey(operation.baseRef, operation.baseId) : undefined;
      declared.set(declaration.ref, { kind: declaration.kind, index, ...(base ? { base } : {}) });
    }
    needs.push(opNeeds);
  }

  return {
    declared: new Map([...declared].map(([ref, { kind, index }]) => [ref, { kind, index }])),
    needs,
  };
}

// ─── Apply ───────────────────────────────────────────────

export type SchemaPlanDispatch = (
  actionId: TablesActionId,
  payload: unknown,
  ids: TablesResourceIds,
) => Promise<PlatformActionResult>;

/** Reads `data.base.id`, `data.table.id`, `data.field.id` … without trusting the shape. */
function nestedId(data: unknown, key: string): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const nested = (data as Record<string, unknown>)[key];
  if (!nested || typeof nested !== 'object') return undefined;
  const id = (nested as { id?: unknown }).id;
  return typeof id === 'number' ? id : undefined;
}

/** Thrown inside one operation: report it skipped (a ref it needs never got an id). */
class SkipOperation extends Error {}

interface Outcome {
  ok: boolean;
  id?: number;
  message?: string;
  /** Refs this operation created, with their ids. */
  created?: Array<{ ref: SchemaPlanRef; kind: SchemaPlanObjectKind; id: number }>;
  /** The Base it touched, when known without another read. */
  baseId?: number;
}

/**
 * Run a plan through `dispatch`. With `prior` (a stored result of the same
 * plan) only the operations that did not apply run again, and the refs it
 * resolved are reused — nothing that applied is created twice.
 */
export async function applySchemaPlan(
  operations: SchemaPlanOperation[],
  dispatch: SchemaPlanDispatch,
  prior?: SchemaPlanApplyResult,
): Promise<SchemaPlanApplyResult> {
  const refs = new Map<SchemaPlanRef, { kind: SchemaPlanObjectKind; id: number }>(Object.entries(prior?.refs ?? {}));
  /** Refs whose object was never created, so anything hanging off them is skipped rather than misapplied. */
  const unresolved = new Map<SchemaPlanRef, string>();
  const previous = new Map((prior?.results ?? []).map((result) => [result.index, result]));
  const results: SchemaPlanOperationResult[] = [];
  const touchedBases = new Set<number>(prior?.baseId === undefined ? [] : [prior.baseId]);
  const tableBases = new Map<number, number>();

  const idOf = (kind: SchemaPlanObjectKind, ref: SchemaPlanRef): number => {
    const reason = unresolved.get(ref);
    if (reason !== undefined) throw new SkipOperation(`the ${kind} "${ref}" was not created: ${reason}`);
    const entry = refs.get(ref);
    if (!entry) throw new SkipOperation(`no ${kind} resolved for "${ref}"`);
    return entry.id;
  };
  const resolve = <T>(value: T): T => {
    try {
      return resolveRefTokens(value, (use) => idOf(use.kind, use.ref));
    } catch (error) {
      if (error instanceof UnresolvedRefError) throw new SkipOperation(error.message);
      throw error;
    }
  };
  const baseOfTable = async (tableId: number): Promise<number | undefined> => {
    const known = tableBases.get(tableId);
    if (known !== undefined) return known;
    const result = await dispatch('getSchema', { tableId }, { tableId });
    const baseId = result.ok
      ? (result.data as { table?: { base_id?: unknown } } | undefined)?.table?.base_id
      : undefined;
    if (typeof baseId !== 'number') return undefined;
    tableBases.set(tableId, baseId);
    return baseId;
  };
  const done = (result: PlatformActionResult, outcome: Omit<Outcome, 'ok'> = {}): Outcome =>
    result.ok ? { ok: true, ...outcome } : { ok: false, message: result.message };

  const run = async (operation: SchemaPlanOperation): Promise<Outcome> => {
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
        if (!result.ok) return { ok: false, message: result.message };
        const baseId = nestedId(result.data, 'base');
        // createBase always makes one table; expose it so later fields can target it.
        const defaultTableId = nestedId((result.data as { schema?: unknown } | undefined)?.schema, 'table');
        const created: NonNullable<Outcome['created']> = [];
        if (baseId !== undefined) created.push({ ref: operation.ref, kind: 'base', id: baseId });
        if (operation.defaultTableRef && defaultTableId !== undefined) {
          created.push({ ref: operation.defaultTableRef, kind: 'table', id: defaultTableId });
          if (baseId !== undefined) tableBases.set(defaultTableId, baseId);
        }
        return { ok: true, id: baseId, created, baseId };
      }

      case 'base.update': {
        const baseId = operation.baseId ?? idOf('base', operation.baseRef!);
        const teamCustomRoleId =
          operation.teamRole === 'custom'
            ? (operation.teamCustomRoleId ?? idOf('role', operation.roleRef!))
            : undefined;
        const result = await dispatch(
          'updateBase',
          {
            baseId,
            name: operation.name,
            description: operation.description,
            visibility: operation.visibility,
            teamRole: operation.teamRole,
            teamCustomRoleId,
          },
          { baseId },
        );
        return done(result, { id: baseId, baseId });
      }

      case 'table.create': {
        const baseId = operation.baseId ?? idOf('base', operation.baseRef!);
        const result = await dispatch(
          'createTable',
          { baseId, name: operation.name, description: operation.description },
          { baseId },
        );
        if (!result.ok) return { ok: false, message: result.message };
        const tableId = nestedId(result.data, 'table');
        if (tableId !== undefined) tableBases.set(tableId, baseId);
        return {
          ok: true,
          id: tableId,
          baseId,
          created: operation.ref && tableId !== undefined ? [{ ref: operation.ref, kind: 'table', id: tableId }] : [],
        };
      }

      case 'table.update': {
        const result = await dispatch(
          'updateTable',
          { tableId: operation.tableId, name: operation.name, description: operation.description },
          { tableId: operation.tableId },
        );
        return done(result, { id: operation.tableId });
      }

      case 'field.create': {
        const tableId = operation.tableId ?? idOf('table', operation.tableRef!);
        const config = resolve(operation.config);
        const result = await dispatch(
          'createField',
          { tableId, name: operation.name, type: operation.type, required: operation.required === true, config },
          { tableId },
        );
        const fieldId = result.ok ? nestedId(result.data, 'field') : undefined;
        return done(result, {
          id: fieldId,
          created: operation.ref && fieldId !== undefined ? [{ ref: operation.ref, kind: 'field', id: fieldId }] : [],
        });
      }

      case 'field.update': {
        const config = resolve(operation.config);
        const result = await dispatch(
          'updateField',
          { fieldId: operation.fieldId, name: operation.name, required: operation.required, config },
          { fieldId: operation.fieldId },
        );
        return done(result, { id: operation.fieldId });
      }

      case 'field.archive': {
        const result = await dispatch('archiveField', { fieldId: operation.fieldId }, { fieldId: operation.fieldId });
        return done(result, { id: operation.fieldId });
      }

      case 'view.create': {
        const tableId = operation.tableId ?? idOf('table', operation.tableRef!);
        const result = await dispatch(
          'createView',
          {
            tableId,
            name: operation.name,
            type: operation.type ?? 'grid',
            scope: operation.scope ?? 'shared',
            config: resolve(operation.config),
          },
          { tableId },
        );
        const viewId = result.ok ? nestedId(result.data, 'view') : undefined;
        return done(result, {
          id: viewId,
          created: operation.ref && viewId !== undefined ? [{ ref: operation.ref, kind: 'view', id: viewId }] : [],
        });
      }

      case 'view.update': {
        const result = await dispatch(
          'updateView',
          {
            viewId: operation.viewId,
            revision: operation.revision,
            name: operation.name,
            type: operation.type,
            config: resolve(operation.config),
          },
          { viewId: operation.viewId },
        );
        return done(result, { id: operation.viewId });
      }

      case 'form.create': {
        const tableId = operation.tableId ?? idOf('table', operation.tableRef!);
        const result = await dispatch(
          'createForm',
          {
            tableId,
            name: operation.name,
            status: operation.status ?? 'draft',
            config: resolve(operation.config),
            audience: operation.audience,
          },
          { tableId },
        );
        const formId = result.ok ? nestedId(result.data, 'form') : undefined;
        return done(result, {
          id: formId,
          created: operation.ref && formId !== undefined ? [{ ref: operation.ref, kind: 'form', id: formId }] : [],
        });
      }

      case 'form.update': {
        const result = await dispatch(
          'updateForm',
          {
            formId: operation.formId,
            revision: operation.revision,
            name: operation.name,
            status: operation.status,
            config: resolve(operation.config),
            audience: operation.audience,
          },
          { formId: operation.formId },
        );
        return done(result, { id: operation.formId });
      }

      case 'automation.create': {
        const tableId = operation.tableId ?? idOf('table', operation.tableRef!);
        const baseId = await baseOfTable(tableId);
        if (baseId === undefined) return { ok: false, message: `table ${tableId} was not found` };
        const result = await dispatch(
          'createAutomation',
          {
            baseId,
            tableId,
            name: operation.name,
            trigger: operation.trigger,
            status: operation.status ?? 'disabled',
            config: resolve(operation.config),
          },
          { baseId },
        );
        const automationId = result.ok ? nestedId(result.data, 'automation') : undefined;
        return done(result, {
          id: automationId,
          baseId,
          created:
            operation.ref && automationId !== undefined
              ? [{ ref: operation.ref, kind: 'automation', id: automationId }]
              : [],
        });
      }

      case 'automation.update': {
        const result = await dispatch(
          'updateAutomation',
          {
            automationId: operation.automationId,
            revision: operation.revision,
            name: operation.name,
            trigger: operation.trigger,
            status: operation.status,
            config: resolve(operation.config),
          },
          { automationId: operation.automationId },
        );
        return done(result, { id: operation.automationId });
      }

      case 'dashboard.create': {
        const baseId = operation.baseId ?? idOf('base', operation.baseRef!);
        const result = await dispatch(
          'createDashboard',
          { baseId, name: operation.name, description: operation.description, config: resolve(operation.config) },
          { baseId },
        );
        const dashboardId = result.ok ? nestedId(result.data, 'dashboard') : undefined;
        return done(result, {
          id: dashboardId,
          baseId,
          created:
            operation.ref && dashboardId !== undefined
              ? [{ ref: operation.ref, kind: 'dashboard', id: dashboardId }]
              : [],
        });
      }

      case 'dashboard.update': {
        const result = await dispatch(
          'updateDashboard',
          {
            dashboardId: operation.dashboardId,
            revision: operation.revision,
            name: operation.name,
            description: operation.description,
            config: resolve(operation.config),
          },
          { dashboardId: operation.dashboardId },
        );
        return done(result, { id: operation.dashboardId });
      }

      case 'widget.create': {
        const dashboardId = operation.dashboardId ?? idOf('dashboard', operation.dashboardRef!);
        const card = resolve(operation.card);
        const result = await dispatch(
          'createDashboardWidget',
          {
            dashboardId,
            title: operation.title,
            config: { version: 2, card },
            layout: operation.layout ? { version: 1, ...operation.layout } : undefined,
            tableId: cardTableId(card),
          },
          { dashboardId },
        );
        const widgetId = result.ok ? nestedId(result.data, 'widget') : undefined;
        return done(result, {
          id: widgetId,
          created:
            operation.ref && widgetId !== undefined ? [{ ref: operation.ref, kind: 'widget', id: widgetId }] : [],
        });
      }

      case 'widget.update': {
        const card = resolve(operation.card);
        const result = await dispatch(
          'updateDashboardWidget',
          {
            widgetId: operation.widgetId,
            revision: operation.revision,
            title: operation.title,
            ...(card ? { config: { version: 2, card }, tableId: cardTableId(card) ?? null } : {}),
            layout: operation.layout ? { version: 1, ...operation.layout } : undefined,
          },
          { widgetId: operation.widgetId },
        );
        return done(result, { id: operation.widgetId });
      }

      case 'widget.delete': {
        const result = await dispatch(
          'deleteDashboardWidget',
          { widgetId: operation.widgetId },
          { widgetId: operation.widgetId },
        );
        return done(result, { id: operation.widgetId });
      }

      case 'role.create': {
        const baseId = operation.baseId ?? idOf('base', operation.baseRef!);
        const result = await dispatch(
          'createRole',
          { baseId, name: operation.name, description: operation.description, rules: resolve(operation.rules) },
          { baseId },
        );
        const roleId = result.ok ? nestedId(result.data, 'role') : undefined;
        return done(result, {
          id: roleId,
          baseId,
          created: operation.ref && roleId !== undefined ? [{ ref: operation.ref, kind: 'role', id: roleId }] : [],
        });
      }

      case 'role.update': {
        const result = await dispatch(
          'updateRole',
          {
            roleId: operation.roleId,
            revision: operation.revision,
            name: operation.name,
            description: operation.description,
            rules: resolve(operation.rules),
          },
          { roleId: operation.roleId },
        );
        return done(result, { id: operation.roleId, baseId: operation.baseId });
      }

      case 'member.set': {
        const baseId = operation.baseId ?? idOf('base', operation.baseRef!);
        const principal =
          operation.principal === 'group'
            ? { principal: 'group', groupId: operation.groupId }
            : { principal: 'user', userId: operation.userId };
        const grant =
          operation.role === 'none'
            ? { operation: 'remove' }
            : {
                role: operation.role,
                customRoleId:
                  operation.role === 'custom'
                    ? (operation.customRoleId ?? idOf('role', operation.roleRef!))
                    : undefined,
              };
        const result = await dispatch('manageMembers', { baseId, ...principal, ...grant }, { baseId });
        return done(result, { baseId });
      }
    }
  };

  for (const [index, operation] of operations.entries()) {
    const earlier = previous.get(index);
    if (earlier?.status === 'applied') {
      results.push(earlier);
      continue;
    }
    let outcome: Outcome;
    let skipped = false;
    try {
      outcome = await run(operation);
    } catch (error) {
      if (!(error instanceof SkipOperation)) throw error;
      outcome = { ok: false, message: error.message };
      skipped = true;
    }
    if (outcome.ok) {
      for (const created of outcome.created ?? []) refs.set(created.ref, { kind: created.kind, id: created.id });
      if (outcome.baseId !== undefined) touchedBases.add(outcome.baseId);
    } else {
      // Anything hanging off what this operation would have created is skipped, not misapplied.
      for (const declaration of declaredRefs(operation)) unresolved.set(declaration.ref, outcome.message ?? 'failed');
    }
    results.push({
      index,
      op: operation.op,
      status: outcome.ok ? 'applied' : skipped ? 'skipped' : 'failed',
      ...(outcome.id === undefined ? {} : { id: outcome.id }),
      ...(outcome.ok || outcome.message === undefined ? {} : { message: outcome.message }),
    });
  }

  // Only offer a "open the Base" link when the plan is unambiguously about one.
  const baseId = touchedBases.size === 1 ? [...touchedBases][0] : undefined;
  const refMap: SchemaPlanRefMap = Object.fromEntries(refs);
  return {
    results,
    ...(baseId === undefined ? {} : { baseId }),
    refs: refMap,
    attempts: (prior?.attempts ?? 1) + (prior ? 1 : 0),
  };
}

/** The table a card reads (its `source.tableId`), when it names one. */
function cardTableId(card: Record<string, unknown> | undefined): number | undefined {
  const source = card?.source;
  const tableId = source && typeof source === 'object' ? (source as { tableId?: unknown }).tableId : undefined;
  return typeof tableId === 'number' ? tableId : undefined;
}
