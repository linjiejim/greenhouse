/** Templates contain a portable schema plan and explicitly supplied sample rows, never Base records. */
import {
  parseTableFieldConfig,
  validateTableFieldValue,
  type DatabaseProvider,
  type TableAppRow,
} from '@greenhouse/db';
import { APP_TEMPLATE_LIMITS, type AppTemplatePublishInput } from '@greenhouse/types/apps';
import type { SchemaPlanOperation, SchemaPlanConfig } from '@greenhouse/types/tables';
import { parseStoredAppSpec } from '../app-spec.js';
import { analyzeSchemaPlan, MAX_SCHEMA_PLAN_OPERATIONS, schemaPlanOperationSchema } from '../schema-plan.js';
import { collectRefTokens } from '../schema-plan-refs.js';
import { scanBundle } from '../../../skills/scanner.js';
import type { AppTemplatePlan, AppTemplateLocale } from './index.js';

export interface TemplateContent {
  name: Record<AppTemplateLocale, string>;
  description: Record<AppTemplateLocale, string>;
  plans: Record<AppTemplateLocale, AppTemplatePlan>;
  appRef: string;
  samples?: Array<{ tableRef: string; values: Array<{ fieldRef: string; value: unknown }> }>;
}
const SAFE_OPS = new Set([
  'base.create',
  'table.create',
  'field.create',
  'view.create',
  'automation.create',
  'dashboard.create',
  'widget.create',
  'app.create',
]);
/** Apply again at install so even historical content cannot activate outbound automations. */
export function sanitizeTemplateOperations(operations: SchemaPlanOperation[]): SchemaPlanOperation[] {
  return operations.map((op) => {
    if (op.op !== 'automation.create') return op;
    const config = structuredClone(op.config) as Record<string, unknown>;
    const actions = Array.isArray(config.actions) ? (config.actions as Array<Record<string, unknown>>) : [];
    config.actions = actions
      .filter((action) => action.type !== 'webhook')
      .filter((action) => {
        if (action.type !== 'notify') return true;
        const recipients = action.recipients as Record<string, unknown> | undefined;
        return (
          !!recipients &&
          !!(
            recipients.creator ||
            recipients.actor ||
            (Array.isArray(recipients.userFieldIds) && recipients.userFieldIds.length)
          )
        );
      })
      .map((action) => {
        if (action.type === 'agent') {
          const { botId: _bot, botVersion: _version, ...portable } = action;
          return portable;
        }
        if (action.type !== 'notify') return action;
        const recipients = action.recipients as Record<string, unknown> | undefined;
        return {
          ...action,
          recipients: recipients
            ? {
                ...(recipients.creator ? { creator: true } : {}),
                ...(recipients.actor ? { actor: true } : {}),
                ...(recipients.userFieldIds ? { userFieldIds: recipients.userFieldIds } : {}),
              }
            : { creator: true },
        };
      });
    if (!(config.actions as unknown[]).length)
      throw new Error('An automation has no portable actions; add an action before exporting it.');
    return { ...op, status: 'disabled' as const, config: config as SchemaPlanConfig };
  });
}
export function checkTemplateContent(content: TemplateContent) {
  const bytes = JSON.stringify(content);
  if (Buffer.byteLength(bytes) > APP_TEMPLATE_LIMITS.contentBytes) throw new Error('Template content exceeds 1 MB');
  for (const plan of Object.values(content.plans)) {
    if (plan.operations.length > MAX_SCHEMA_PLAN_OPERATIONS) throw new Error('Template has too many operations');
    if (plan.operations[0]?.op !== 'base.create' || plan.operations[0].visibility !== 'private')
      throw new Error('Templates must create a private Base');
    if (
      plan.operations.filter((op) => op.op === 'base.create').length !== 1 ||
      plan.operations.filter((op) => op.op === 'app.create').length !== 1
    )
      throw new Error('Templates create one Base and one draft app');
    for (const op of plan.operations) {
      if (!SAFE_OPS.has(op.op)) throw new Error(`Template operation ${op.op} is not permitted`);
      schemaPlanOperationSchema.parse(op);
      for (const key of ['baseId', 'tableId', 'appId', 'fieldId', 'viewId', 'dashboardId'])
        if (key in op) throw new Error('Templates must use new-object references');
    }
    const shape = analyzeSchemaPlan(plan.operations);
    if ('error' in shape) throw new Error(shape.error);
  }
  const plan = content.plans.en;
  const customCards = plan.operations.reduce(
    (sum, op) =>
      op.op === 'app.create' ? sum + (JSON.stringify(op.spec).match(/"kind":"custom"/g) ?? []).length : sum,
    0,
  );
  const automations = plan.operations.filter((op) => op.op === 'automation.create').length;
  const scan = scanBundle([{ path: 'template.json', content: bytes }], {
    name: content.name.en,
    description: content.description.en,
  });
  return { content: bytes, customCards, automations, scan };
}

/** Structure + draft only. In particular this function never calls queryRecords/getRecord. */
export async function exportTemplateContent(
  db: DatabaseProvider,
  app: TableAppRow,
  input: AppTemplatePublishInput,
): Promise<TemplateContent> {
  const base = await db.tables.getBase(app.base_id);
  if (!base) throw new Error('Base not found');
  const tables = await db.tables.listTables(base.id);
  const schemas = await Promise.all(tables.map((table) => db.tables.getSchema(table.id)));
  const fields = schemas.flatMap((schema) => schema?.fields ?? []);
  const rules = await db.tables.listAutomationRules(base.id);
  const tableRefs = new Map(tables.map((table) => [table.id, `t${table.id}`]));
  const fieldRefs = new Map(fields.map((field) => [field.id, `f${field.id}`]));
  const ruleRefs = new Map(rules.map((rule) => [rule.id, `a${rule.id}`]));
  const replace = (value: unknown, key = ''): unknown => {
    if (key === 'input' || key === 'html' || key === 'markdown') return value;
    if (typeof value === 'string')
      return value.replace(/\{\{\s*field\s*:\s*(\d+)\s*\}\}/g, (_, id: string) => {
        const ref = fieldRefs.get(Number(id));
        if (!ref) throw new Error('Automation refers to a field outside the Base');
        return `{{field:$field:${ref}}}`;
      });
    if (typeof value === 'number') {
      const map = /tableId$/i.test(key)
        ? tableRefs
        : /fieldIds?$/i.test(key)
          ? fieldRefs
          : key === 'automationId'
            ? ruleRefs
            : undefined;
      if (!map) return value;
      const ref = map.get(value);
      if (!ref) throw new Error(`Template references an object outside its Base (${key})`);
      return `$${map === tableRefs ? 'table' : map === fieldRefs ? 'field' : 'automation'}:${ref}`;
    }
    if (Array.isArray(value)) return value.map((item) => replace(item, key));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        /^\d+$/.test(k) && fieldRefs.has(Number(k)) ? `$field:${fieldRefs.get(Number(k))}` : k,
        replace(v, k),
      ]),
    );
  };
  const operations: SchemaPlanOperation[] = [];
  const defined = new Set<string>();
  for (const [i, table] of tables.entries()) {
    const primary = fields.find((field) => field.table_id === table.id && field.is_primary);
    if (!primary) throw new Error('Table has no primary field');
    const common = { primaryFieldRef: fieldRefs.get(primary.id)!, primaryFieldName: primary.name };
    if (!i)
      operations.push({
        op: 'base.create',
        ref: 'base',
        name: input.name ?? app.name,
        visibility: 'private',
        defaultTableRef: tableRefs.get(table.id),
        defaultTableName: table.name,
        ...common,
      });
    else
      operations.push({
        op: 'table.create',
        ref: tableRefs.get(table.id),
        baseRef: 'base',
        name: table.name,
        ...common,
      });
    defined.add(`table:${tableRefs.get(table.id)}`);
    defined.add(`field:${fieldRefs.get(primary.id)}`);
  }
  if (!tables.length) throw new Error('A template needs at least one table');
  const pending = fields
    .filter((field) => !field.is_primary)
    .map(
      (field) =>
        ({
          op: 'field.create',
          ref: fieldRefs.get(field.id),
          tableRef: tableRefs.get(field.table_id),
          name: field.name,
          type: field.type,
          required: field.required,
          config: replace(parseTableFieldConfig(field)),
        }) as SchemaPlanOperation,
    );
  while (pending.length) {
    const i = pending.findIndex((op) =>
      collectRefTokens(op).every((token) => defined.has(`${token.kind}:${token.ref}`)),
    );
    if (i < 0) throw new Error('Cyclic or unsupported field dependencies');
    const op = pending.splice(i, 1)[0]!;
    operations.push(op);
    if (op.op === 'field.create') defined.add(`field:${op.ref}`);
  }
  for (const rule of rules)
    operations.push({
      op: 'automation.create',
      ref: ruleRefs.get(rule.id),
      tableRef: tableRefs.get(rule.table_id),
      name: rule.name,
      trigger: rule.trigger,
      status: 'disabled',
      config: replace(rule.config) as SchemaPlanConfig,
    });
  const spec = parseStoredAppSpec(app.draft_spec);
  if (!spec) throw new Error('App draft is invalid');
  operations.push({
    op: 'app.create',
    ref: 'app',
    baseRef: 'base',
    name: input.name ?? app.name,
    description: input.description ?? app.description ?? '',
    icon: input.icon ?? app.icon,
    accent: input.accent ?? app.accent,
    spec: replace(spec) as SchemaPlanConfig,
  });
  const samples = input.sampleRecords?.map((sample) => {
    const tableRef = tableRefs.get(sample.tableId);
    if (!tableRef) throw new Error('Sample table is outside the template');
    for (const field of fields.filter((field) => field.table_id === sample.tableId && field.required)) {
      if (['formula', 'lookup', 'rollup', 'ai'].includes(field.type)) continue;
      const value = sample.values.find((entry) => entry.fieldId === field.id)?.value;
      if (value === undefined || value === null || value === '')
        throw new Error(`Sample field "${field.name}" is required`);
    }
    return {
      tableRef,
      values: sample.values.map((entry) => {
        const field = fields.find((f) => f.id === entry.fieldId && f.table_id === sample.tableId);
        if (
          !field ||
          ['user', 'multi_user', 'relation', 'attachment', 'formula', 'lookup', 'rollup', 'ai'].includes(field.type)
        )
          throw new Error('Samples only support writable scalar fields');
        return { fieldRef: fieldRefs.get(field.id)!, value: validateTableFieldValue(field, entry.value, new Set()) };
      }),
    };
  });
  const plan = {
    summary: input.description ?? app.description ?? app.name,
    operations: sanitizeTemplateOperations(operations),
  };
  return {
    name: { en: input.name ?? app.name, zh: input.name ?? app.name },
    description: { en: input.description ?? app.description ?? '', zh: input.description ?? app.description ?? '' },
    appRef: 'app',
    plans: { en: plan, zh: plan },
    ...(samples?.length ? { samples } : {}),
  };
}
