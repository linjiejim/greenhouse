/**
 * Built-in app templates (spec 20261011-tables-apps §7, acceptance 6).
 *
 * A template is a fixed schema plan in a JSON file beside this module. It is
 * installed through the SAME path a confirmed plan takes — `applySchemaPlan`,
 * every operation a runtime action dispatched as the installer — so a template
 * can never do more than the installer could by hand, and the files double as
 * the deterministic CI fixtures (`__tests__/app-templates.db.test.ts`: every
 * template drafts with no problem and applies with no failed operation).
 *
 * What a template may contain is narrow on purpose, checked when the catalog
 * loads (a bad file fails the boot path that reads it, and the catalog test):
 * - it starts with `base.create` — a NEW Base the installer owns — and names
 *   nothing that exists (every id is a plan ref);
 * - structure, automations (always `disabled`: nothing runs until the owner
 *   turns it on), dashboards and exactly one `app.create`, which stays a DRAFT;
 * - no grants, roles, forms, audiences or publishing — nothing reaches anyone
 *   but the installer until they decide to share it; no webhooks (D16).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { APP_ACCENTS, APP_ICONS, type AppTemplateSummary } from '@greenhouse/types/apps';
import type { SchemaPlanOperation, SchemaPlanOperationKind } from '@greenhouse/types/tables';
import { analyzeSchemaPlan, MAX_SCHEMA_PLAN_OPERATIONS, schemaPlanOperationSchema } from '../schema-plan.js';

/** The catalog, in the order the app center lists it. One JSON file per key. */
export const APP_TEMPLATE_KEYS = ['procurement', 'it-tickets'] as const;
export type AppTemplateKey = (typeof APP_TEMPLATE_KEYS)[number];

const ALLOWED_OPS: ReadonlySet<SchemaPlanOperationKind> = new Set([
  'base.create',
  'table.create',
  'field.create',
  'view.create',
  'automation.create',
  'dashboard.create',
  'widget.create',
  'app.create',
]);

const words = z.object({ zh: z.string().min(1).max(500), en: z.string().min(1).max(500) });

const templateSchema = z.object({
  key: z.enum(APP_TEMPLATE_KEYS),
  name: words,
  description: words,
  icon: z.enum(APP_ICONS),
  accent: z.enum(APP_ACCENTS),
  /** The plan's one-line summary. */
  summary: z.string().min(1).max(500),
  operations: z.array(schemaPlanOperationSchema).min(1).max(MAX_SCHEMA_PLAN_OPERATIONS),
});

export interface AppTemplate {
  key: AppTemplateKey;
  name: { zh: string; en: string };
  description: { zh: string; en: string };
  icon: AppTemplateSummary['icon'];
  accent: AppTemplateSummary['accent'];
  summary: string;
  operations: SchemaPlanOperation[];
  /** The ref of its `app.create` — where the installed app's id is found in the apply result. */
  appRef: string;
}

/** The ids an operation may name directly — a template names none of them (everything is a ref). */
const ID_KEYS = [
  'baseId',
  'tableId',
  'fieldId',
  'viewId',
  'formId',
  'automationId',
  'dashboardId',
  'widgetId',
  'roleId',
  'appId',
] as const;

/** Why a template file is not a template, or undefined. */
function templateProblem(template: z.infer<typeof templateSchema>): string | undefined {
  const [first] = template.operations;
  if (first?.op !== 'base.create') return 'must start with base.create (a new Base the installer owns)';
  if (first.visibility === 'team') return 'its Base must be private';
  const apps = template.operations.filter((operation) => operation.op === 'app.create');
  if (apps.length !== 1 || !apps[0]!.ref) return 'must create exactly one app, with a ref';
  for (const [index, operation] of template.operations.entries()) {
    if (!ALLOWED_OPS.has(operation.op)) return `operation ${index + 1}: ${operation.op} is not allowed in a template`;
    if (index > 0 && operation.op === 'base.create') return `operation ${index + 1}: only one Base`;
    const record = operation as Record<string, unknown>;
    const named = ID_KEYS.find((key) => record[key] !== undefined);
    if (named) return `operation ${index + 1}: names an existing object (${named}) — use refs`;
    if (operation.op === 'automation.create' && operation.status === 'enabled') {
      return `operation ${index + 1}: automations start disabled`;
    }
  }
  const shape = analyzeSchemaPlan(template.operations);
  return 'error' in shape ? shape.error : undefined;
}

function loadTemplate(key: AppTemplateKey): AppTemplate {
  const path = resolve(import.meta.dirname, `${key}.json`);
  const parsed = templateSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`App template ${key}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`);
  }
  if (parsed.data.key !== key) throw new Error(`App template ${key}: the file says it is "${parsed.data.key}"`);
  const problem = templateProblem(parsed.data);
  if (problem) throw new Error(`App template ${key}: ${problem}`);
  const app = parsed.data.operations.find((operation) => operation.op === 'app.create');
  return { ...parsed.data, operations: parsed.data.operations, appRef: (app as { ref: string }).ref };
}

let catalog: ReadonlyMap<AppTemplateKey, AppTemplate> | undefined;

/** Every template, validated once per process. */
export function appTemplates(): ReadonlyMap<AppTemplateKey, AppTemplate> {
  catalog ??= new Map(APP_TEMPLATE_KEYS.map((key) => [key, loadTemplate(key)]));
  return catalog;
}

export function findAppTemplate(key: string): AppTemplate | undefined {
  return (APP_TEMPLATE_KEYS as readonly string[]).includes(key) ? appTemplates().get(key as AppTemplateKey) : undefined;
}

/** What the app center lists, in the viewer's language. */
export function appTemplateSummaries(locale: 'en' | 'zh'): AppTemplateSummary[] {
  return [...appTemplates().values()].map((template) => ({
    key: template.key,
    name: template.name[locale],
    description: template.description[locale],
    icon: template.icon,
    accent: template.accent,
  }));
}
