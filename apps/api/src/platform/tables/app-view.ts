/**
 * What an app looks like on the wire: the summary every list carries, and the
 * runtime view (spec + the field metadata to render it + D6 issues) — for a
 * manager in full, or trimmed to one role (a manager's "preview as role"; the
 * gateway serves the same trim to a viewer once it has resolved their role,
 * slice G).
 *
 * Pure apart from the inputs: callers load the app row, the spec and the
 * Base schema (`app-spec.ts` `loadAppSpecSchema`).
 */

import { parseTableFieldConfig, type TableAppRow, type TableAppSummaryRow, type TableFieldRow } from '@greenhouse/db';
import {
  actionAllowedForRole,
  appSpecDependencies,
  findRole,
  pagesForRole,
  type AppButton,
  type AppCard,
  type AppIssue,
  type AppRecordAction,
  type AppRuntimeView,
  type AppSpec,
  type AppSummary,
} from '@greenhouse/types/apps';
import {
  compileTableAccessScope,
  computeFieldAccess,
  normalizeAccessRules,
  type TableAccessRules,
} from '@greenhouse/types/table-access';
import { isComputedFieldType } from '@greenhouse/types/tables';
import type { AppSpecSchema } from './app-spec.js';

/** The manager pseudo-role of `AppRuntimeView.role`. */
export const APP_MANAGER_ROLE = { key: '__manager__', name: 'Manager' } as const;

export interface AppCallerFlags {
  canManage: boolean;
  canPublish: boolean;
  pinned: boolean;
}

export function appSummary(row: TableAppSummaryRow | TableAppRow, flags: AppCallerFlags): AppSummary {
  return {
    id: row.id,
    baseId: row.base_id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    accent: row.accent,
    ownerId: row.owner_id,
    status: row.status,
    publishedVersion: row.published_version,
    featured: row.featured,
    updatedAt: row.updated_at,
    canManage: flags.canManage,
    canPublish: flags.canPublish,
    pinned: flags.pinned,
  };
}

function rulesOf(spec: AppSpec, roleKey: string): TableAccessRules | undefined {
  const role = findRole(spec, roleKey);
  if (!role) return undefined;
  const normalized = normalizeAccessRules({ version: 1, tables: role.tables, dashboards: 'none' });
  return normalized.ok ? normalized.rules : { version: 1, tables: [], dashboards: 'none' };
}

function allowedActions(
  spec: AppSpec,
  pageId: string,
  roleKey: string,
  actions: AppRecordAction[] | undefined,
): AppRecordAction[] | undefined {
  return actions?.filter((action) => actionAllowedForRole(spec, pageId, action, roleKey));
}

function forRole(roles: readonly string[] | undefined, roleKey: string): boolean {
  return !roles || roles.includes(roleKey);
}

/**
 * The spec as one role sees it: only its pages; only the actions, buttons,
 * forms, create and move affordances it may use; `roles` reduced to that role
 * (another role's rules are none of its business). A card list never gains
 * anything — trimming only removes.
 */
export function trimSpecForRole(spec: AppSpec, roleKey: string): AppSpec | undefined {
  const role = findRole(spec, roleKey);
  if (!role) return undefined;
  const pages = pagesForRole(spec, role).map((page) => ({
    ...page,
    cards: page.cards.flatMap((card): AppCard[] => {
      switch (card.kind) {
        case 'records':
        case 'kanban':
        case 'calendar':
        case 'gallery': {
          const trimmed = { ...card, actions: allowedActions(spec, page.id, roleKey, card.actions) };
          if (card.detail) {
            trimmed.detail = { ...card.detail, actions: allowedActions(spec, page.id, roleKey, card.detail.actions) };
          }
          if (trimmed.kind === 'records' && trimmed.create && !forRole(trimmed.create.roles, roleKey)) {
            delete trimmed.create;
          }
          if (trimmed.kind === 'kanban' && trimmed.move && !forRole(trimmed.move.roles, roleKey)) delete trimmed.move;
          return [trimmed as AppCard];
        }
        case 'form':
          return forRole(card.roles, roleKey) ? [card] : [];
        case 'buttons': {
          const buttons = card.buttons.filter((button: AppButton) => forRole(button.roles, roleKey));
          return buttons.length > 0 ? [{ ...card, buttons }] : [];
        }
        default:
          return [card];
      }
    }),
  }));
  const trimmed: AppSpec = { ...spec, pages, roles: [role] };
  if (!pages.some((page) => page.id === spec.home)) delete trimmed.home;
  return trimmed;
}

/**
 * Field metadata for the tables a spec's cards use: the fields the spec
 * references, live, and — for a role — readable by it, with `editable` from
 * the same compiled scope every write is checked against. Managers see every
 * referenced field; computed ones are never editable. `required` is the
 * field's own flag (a create checks it for the fields the writer may edit).
 */
export async function appTablesView(
  spec: AppSpec,
  schema: AppSpecSchema,
  roleKey?: string,
): Promise<AppRuntimeView['tables']> {
  const deps = appSpecDependencies(spec);
  const referenced = new Set(deps.fieldIds);
  const names = new Map(schema.facts.tables.map((table) => [table.id, table.name ?? `Table ${table.id}`]));
  const rules = roleKey ? rulesOf(spec, roleKey) : undefined;
  const fieldAccess = rules ? computeFieldAccess(rules, schema.facts) : undefined;
  const out: AppRuntimeView['tables'] = [];
  for (const tableId of deps.tableIds) {
    if (!names.has(tableId)) continue;
    const scope = rules ? compileTableAccessScope(rules, tableId, schema.facts, 'app-view', fieldAccess) : undefined;
    if (rules && !scope) continue;
    const readable = scope ? new Set(scope.readableFieldIds) : undefined;
    const editable = scope ? new Set(scope.editableFieldIds) : undefined;
    const rows: TableFieldRow[] = await schema.source.fields(tableId);
    out.push({
      id: tableId,
      name: names.get(tableId)!,
      canCreate: scope ? scope.canCreate : true,
      fields: rows
        .filter((row) => (row.is_primary || referenced.has(row.id)) && (!readable || readable.has(row.id)))
        .map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type,
          isPrimary: row.is_primary,
          config: parseTableFieldConfig(row),
          editable: editable ? editable.has(row.id) : !isComputedFieldType(row.type),
          required: row.required,
        })),
    });
  }
  return out;
}

/** The runtime view of `spec` for a manager (full) or a role (trimmed). Undefined when the role does not exist. */
export async function appRuntimeView(input: {
  app: AppSummary;
  version: number;
  draft: boolean;
  spec: AppSpec;
  schema: AppSpecSchema;
  issues: AppIssue[];
  roleKey?: string;
}): Promise<AppRuntimeView | undefined> {
  const role = input.roleKey ? findRole(input.spec, input.roleKey) : undefined;
  if (input.roleKey && !role) return undefined;
  const spec = role ? trimSpecForRole(input.spec, role.key)! : input.spec;
  const visiblePages = new Set(spec.pages.map((page) => page.id));
  return {
    app: input.app,
    version: input.version,
    ...(input.draft ? { draft: true } : {}),
    role: role ? { key: role.key, name: role.name } : { ...APP_MANAGER_ROLE },
    spec,
    tables: await appTablesView(spec, input.schema, role?.key),
    issues: role ? input.issues.filter((issue) => visiblePages.has(issue.pageId)) : input.issues,
  };
}
