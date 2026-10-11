/**
 * Draft-time validation of a schema plan against a virtual schema (spec §9).
 *
 * The virtual schema is the existing schema as the drafting user reads it
 * (every read goes through `dispatch`, as that user) plus the objects the plan
 * declares, under placeholder ids. Each operation's config — with its
 * `$<kind>:<ref>` tokens rewritten to those placeholders — runs through the
 * SAME validators the handlers use (`@greenhouse/db` `check*` with a virtual
 * `TablesSchemaSource`, `normalizeAccessRules`, `normalizeTableCardSpec`,
 * `validateTablesSchedule`), and through the same permission levels. Every
 * problem is returned to the model before any card is shown.
 *
 * The same pass derives the permission changes the card lists before Confirm:
 * member and group grants, the team role, custom role rules and form
 * audiences, each as before → after from the current grants.
 *
 * This is a preview, not an authorization: the apply route re-authorizes and
 * re-validates every operation through its own runtime action.
 */

import {
  checkAutomationConfig,
  checkDashboardConfig,
  checkFieldConfig,
  checkFormAudience,
  checkFormConfig,
  checkViewConfig,
  checkWidgetCard,
  type TableAutomationConfigInput,
  type TableFieldRow,
  type TablesSchemaSource,
} from '@greenhouse/db';
import {
  type SchemaPlanAccessChange,
  type SchemaPlanAccessLevel,
  type SchemaPlanAudienceView,
  type SchemaPlanObjectKind,
  type SchemaPlanOperation,
  type SchemaPlanRuleSummary,
  type TableAutomationTrigger,
  type TableBaseVisibility,
  type TableDashboardWidgetType,
  type TableFieldConfig,
  type TableFormAudience,
  type TableFormConfig,
  type TableViewScope,
  type TableViewType,
} from '@greenhouse/types/tables';
import {
  fullTableAccess,
  normalizeAccessRules,
  type TableAccessRules,
  type TableBaseAccessLevel,
} from '@greenhouse/types/table-access';
import { normalizeTableCardSpec, widgetTypeForCard } from '@greenhouse/types/table-cards';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import { validateTablesSchedule } from './automation-schedule.js';
import { analyzeSchemaPlan, keepStoredWebhooks, WEBHOOK_REFUSAL, type SchemaPlanDispatch } from './schema-plan.js';
import { resolveRefTokens } from './schema-plan-refs.js';

/** What the draft check reads, all as the drafting user. */
export interface SchemaPlanReader {
  /** Tables read actions (getBase, getSchema, listRoles, …) dispatched as the drafter. */
  dispatch: SchemaPlanDispatch;
  /** The drafter's id: the owner of any Base the plan creates. */
  userId: string;
  /** Groups the drafter may grant or name — creator, member, or every group for a super (D12). */
  grantableGroups(): Promise<Array<{ id: number; name: string }>>;
}

export type SchemaPlanDraft =
  | {
      ok: true;
      accessChanges: SchemaPlanAccessChange[];
      /** Operation index → the current name of the existing object it changes (see the artifact's `targetNames`). */
      targetNames: Record<number, string>;
    }
  | { ok: false; problems: string[] };

/** Placeholder ids for plan-declared objects; far above any real serial id, and positive (validators require it). */
const PLACEHOLDER_START = 2_000_000_000;

type Role = 'owner' | 'builder' | 'editor';

interface DraftBase {
  id: number;
  name: string;
  ownerId: string | null;
  level: TableBaseAccessLevel;
  visibility: TableBaseVisibility;
  teamRole: 'viewer' | 'editor' | 'custom';
  teamCustomRoleId: number | null;
  /** Visible tables: id → name (existing and plan-declared). */
  tables: Map<number, string>;
  dashboards: Set<string>;
  placeholder: boolean;
}

interface DraftView {
  id: number;
  type: TableViewType;
  scope: TableViewScope;
  config: unknown;
  revision: number;
}

interface DraftTable {
  id: number;
  baseId: number;
  name: string;
  fields: TableFieldRow[];
  views: DraftView[];
  placeholder: boolean;
}

interface DraftRole {
  id: number;
  name: string;
  rules: TableAccessRules;
  revision: number;
}

interface DraftGrants {
  users: Map<string, { role: string; customRoleId: number | null }>;
  groups: Map<number, { name: string; role: string; customRoleId: number | null }>;
}

interface DraftDashboard {
  id: number;
  baseId: number;
  name: string;
  revision: number;
  widgets: Map<number, { type: TableDashboardWidgetType; revision: number; title: string }>;
}

interface DraftForm {
  id: number;
  tableId: number;
  name: string;
  status: 'draft' | 'published';
  config: TableFormConfig;
  audience: TableFormAudience;
  revision: number;
}

interface DraftAutomation {
  id: number;
  tableId: number;
  name: string;
  trigger: TableAutomationTrigger;
  config: Record<string, unknown>;
  revision: number;
}

/** A problem already reported: the operation stops, nothing else about it is said. */
class Reported extends Error {}

function object(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

function list(data: unknown, key: string): Record<string, unknown>[] {
  const value = object(data)[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    : [];
}

const ROLE_LEVELS: Readonly<Record<Role, readonly TableBaseAccessLevel[]>> = {
  owner: ['owner'],
  builder: ['owner', 'builder'],
  // A personal view: editor+, or a custom role that can read the table (getSchema already proved that).
  editor: ['owner', 'builder', 'editor', 'custom'],
};

function opLabel(operation: SchemaPlanOperation, at: number): string {
  const named =
    'name' in operation && typeof operation.name === 'string'
      ? ` "${operation.name}"`
      : 'title' in operation && typeof operation.title === 'string'
        ? ` "${operation.title}"`
        : '';
  return `operation ${at} (${operation.op}${named})`;
}

/**
 * Validate `operations` against a virtual schema; on success, the access
 * changes the card shows before Confirm.
 */
export async function draftSchemaPlan(
  operations: SchemaPlanOperation[],
  reader: SchemaPlanReader,
): Promise<SchemaPlanDraft> {
  const shape = analyzeSchemaPlan(operations);
  if ('error' in shape) return { ok: false, problems: [shape.error] };

  const problems: string[] = [];
  const accessChanges: SchemaPlanAccessChange[] = [];
  const targetNames: Record<number, string> = {};
  /** The card names what an operation changes, archives or deletes — never just `#17` or a user id. */
  const named = (index: number, name: string) => {
    if (name) targetNames[index] = name;
  };
  let nextPlaceholder = PLACEHOLDER_START;
  const labels = new Map<number, string>();
  const refs = new Map<string, { kind: SchemaPlanObjectKind; id: number }>();

  const alloc = (label: string): number => {
    const id = nextPlaceholder++;
    labels.set(id, label);
    return id;
  };
  /** Validator messages name placeholders by the ref the model wrote. */
  const legible = (message: string): string =>
    message.replace(/\b2\d{9}\b/g, (digits) => labels.get(Number(digits)) ?? digits);

  // ── Reads (memoized; a failed read is undefined) ──
  const memo = <K, V>() => new Map<K, Promise<V>>();
  const read = async (...args: Parameters<SchemaPlanDispatch>) => {
    const result = await reader.dispatch(...args);
    return result.ok ? result.data : undefined;
  };

  const baseCache = memo<number, DraftBase | undefined>();
  const tableCache = memo<number, DraftTable | undefined>();
  const grantCache = memo<number, DraftGrants | undefined>();
  const roleCache = memo<number, DraftRole[] | undefined>();
  const automationCache = memo<number, DraftAutomation[] | undefined>();
  const formCache = memo<number, DraftForm | undefined>();
  const formNameCache = memo<number, Set<string>>();
  const dashboardCache = memo<number, DraftDashboard | undefined>();
  let userList: Promise<Array<{ id: string; name: string }>> | undefined;
  let groupList: Promise<Array<{ id: number; name: string }>> | undefined;

  const loadBase = (id: number) => {
    let found = baseCache.get(id);
    if (!found) {
      found = read('getBase', { baseId: id }, { baseId: id }).then((data): DraftBase | undefined => {
        if (!data) return undefined;
        const base = object(object(data).base);
        const access = object(object(data).access);
        return {
          id,
          name: String(base.name ?? `#${id}`),
          ownerId: typeof base.owner_id === 'string' ? base.owner_id : null,
          level: (access.level as TableBaseAccessLevel | undefined) ?? 'none',
          visibility: base.visibility === 'team' ? 'team' : 'private',
          teamRole: (base.team_role as DraftBase['teamRole'] | undefined) ?? 'viewer',
          teamCustomRoleId: typeof base.team_custom_role_id === 'number' ? base.team_custom_role_id : null,
          tables: new Map(list(data, 'tables').map((table) => [Number(table.id), String(table.name)])),
          dashboards: new Set(list(data, 'dashboards').map((dashboard) => String(dashboard.name))),
          placeholder: false,
        };
      });
      baseCache.set(id, found);
    }
    return found;
  };

  const loadTable = (id: number) => {
    let found = tableCache.get(id);
    if (!found) {
      found = read('getSchema', { tableId: id }, { tableId: id }).then((data): DraftTable | undefined => {
        const table = object(object(data).table);
        if (!data || typeof table.base_id !== 'number') return undefined;
        return {
          id,
          baseId: table.base_id,
          name: String(table.name ?? `#${id}`),
          fields: list(data, 'fields') as unknown as TableFieldRow[],
          views: list(data, 'views').map((view) => ({
            id: Number(view.id),
            type: view.type as TableViewType,
            scope: view.scope === 'personal' ? 'personal' : 'shared',
            config: typeof view.config === 'string' ? safeJsonParse(view.config, {}) : view.config,
            revision: Number(view.revision),
          })),
          placeholder: false,
        };
      });
      tableCache.set(id, found);
    }
    return found;
  };

  const loadGrants = (baseId: number) => {
    let found = grantCache.get(baseId);
    if (!found) {
      found = read('listMembers', { baseId }, { baseId }).then((data): DraftGrants | undefined =>
        data
          ? {
              users: new Map(
                list(data, 'members').map((member) => [
                  String(member.user_id),
                  {
                    role: String(member.role),
                    customRoleId: typeof member.custom_role_id === 'number' ? member.custom_role_id : null,
                  },
                ]),
              ),
              groups: new Map(
                list(data, 'groups').map((group) => [
                  Number(group.groupId),
                  {
                    name: String(group.name),
                    role: String(group.role),
                    customRoleId: typeof group.customRoleId === 'number' ? group.customRoleId : null,
                  },
                ]),
              ),
            }
          : undefined,
      );
      grantCache.set(baseId, found);
    }
    return found;
  };

  const loadRoles = (baseId: number) => {
    let found = roleCache.get(baseId);
    if (!found) {
      found = read('listRoles', { baseId }, { baseId }).then((data) =>
        data
          ? list(data, 'roles').map((role) => ({
              id: Number(role.id),
              name: String(role.name),
              rules: role.rules as TableAccessRules,
              revision: Number(role.revision),
            }))
          : undefined,
      );
      roleCache.set(baseId, found);
    }
    return found;
  };

  const loadAutomations = (baseId: number) => {
    let found = automationCache.get(baseId);
    if (!found) {
      found = read('listAutomations', { baseId }, { baseId }).then((data) =>
        data
          ? list(data, 'automations').map((rule) => ({
              id: Number(rule.id),
              tableId: Number(rule.table_id),
              name: String(rule.name),
              trigger: rule.trigger as TableAutomationTrigger,
              config: object(rule.config),
              revision: Number(rule.revision),
            }))
          : undefined,
      );
      automationCache.set(baseId, found);
    }
    return found;
  };

  const loadForm = (formId: number) => {
    let found = formCache.get(formId);
    if (!found) {
      found = read('getForm', { formId }, { formId }).then((data): DraftForm | undefined => {
        const form = object(object(data).form);
        if (!data || typeof form.table_id !== 'number') return undefined;
        return {
          id: formId,
          tableId: form.table_id,
          name: String(form.name),
          status: form.status === 'published' ? 'published' : 'draft',
          config: form.config as TableFormConfig,
          audience: (form.audience as TableFormAudience | undefined) ?? { type: 'base' },
          revision: Number(form.revision),
        };
      });
      formCache.set(formId, found);
    }
    return found;
  };

  const loadFormNames = (tableId: number) => {
    let found = formNameCache.get(tableId);
    if (!found) {
      found = read('listForms', { tableId }, { tableId }).then(
        (data) => new Set(list(data, 'forms').map((form) => String(form.name))),
      );
      formNameCache.set(tableId, found);
    }
    return found;
  };

  const loadDashboard = (dashboardId: number) => {
    let found = dashboardCache.get(dashboardId);
    if (!found) {
      found = read('getDashboard', { dashboardId }, { dashboardId }).then((data): DraftDashboard | undefined => {
        const dashboard = object(object(data).dashboard);
        if (!data || typeof dashboard.base_id !== 'number') return undefined;
        return {
          id: dashboardId,
          baseId: dashboard.base_id,
          name: String(dashboard.name),
          revision: Number(dashboard.revision),
          widgets: new Map(
            list(data, 'widgets').map((widget) => [
              Number(widget.id),
              {
                type: widget.type as TableDashboardWidgetType,
                revision: Number(widget.revision),
                title: typeof widget.title === 'string' ? widget.title : '',
              },
            ]),
          ),
        };
      });
      dashboardCache.set(dashboardId, found);
    }
    return found;
  };

  const users = () =>
    (userList ??= read('listAssignableUsers', {}, {}).then((data) =>
      list(data, 'users').map((user) => ({ id: String(user.id), name: String(user.nickname ?? user.id) })),
    ));
  const groups = () => (groupList ??= reader.grantableGroups());

  /** The virtual schema the db validators read. */
  const source: TablesSchemaSource = {
    async table(tableId) {
      const table = await loadTable(tableId);
      return table ? { id: table.id, base_id: table.baseId, archived: false } : undefined;
    },
    async fields(tableId) {
      return (await loadTable(tableId))?.fields ?? [];
    },
    async activeUserIds() {
      return new Set((await users()).map((user) => user.id));
    },
    async existingGroupIds(ids) {
      const known = new Set((await groups()).map((group) => group.id));
      return new Set(ids.filter((id) => known.has(id)));
    },
  };

  // ── Placeholders ──
  const placeholderTable = (baseId: number, name: string, ref: string | undefined): DraftTable => {
    const id = alloc(ref ? `$table:${ref}` : `table "${name}"`);
    const now = new Date(0).toISOString();
    const primary: TableFieldRow = {
      id: alloc(`the "Name" field of ${ref ? `$table:${ref}` : `table "${name}"`}`),
      table_id: id,
      name: 'Name',
      type: 'text',
      required: true,
      is_primary: true,
      config: '{}',
      position: 0,
      created_by: reader.userId,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    const table: DraftTable = { id, baseId, name, fields: [primary], views: [], placeholder: true };
    tableCache.set(id, Promise.resolve(table));
    formNameCache.set(id, Promise.resolve(new Set()));
    if (ref) refs.set(ref, { kind: 'table', id });
    return table;
  };

  // ── Per-operation helpers (throw Reported after recording a problem) ──
  let current = '';
  const problem: (message: string) => never = (message) => {
    problems.push(`${current}: ${legible(message)}`);
    throw new Reported();
  };
  const refId = (ref: string): number => refs.get(ref)?.id ?? problem(`ref "${ref}" has no placeholder`);
  const resolve = <T>(value: T): T => {
    try {
      return resolveRefTokens(value, (use) => refs.get(use.ref)?.id);
    } catch (error) {
      return problem(toErrorMessage(error));
    }
  };
  /** Run a validator; its error becomes this operation's problem. */
  const check = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Reported) throw error;
      return problem(toErrorMessage(error));
    }
  };

  const requireBase = async (baseId: number, role: Role, what: string): Promise<DraftBase> => {
    const base = (await loadBase(baseId)) ?? problem(`Base ${baseId} was not found, or you cannot see it`);
    if (!ROLE_LEVELS[role].includes(base.level)) {
      problem(
        role === 'owner'
          ? `only the creator of Base ${baseId} can ${what} — your role there is "${base.level}"`
          : `changing the structure of Base ${baseId} needs the builder role — yours is "${base.level}"`,
      );
    }
    return base;
  };
  const requireTable = async (tableId: number, role: Role): Promise<{ table: DraftTable; base: DraftBase }> => {
    const table = (await loadTable(tableId)) ?? problem(`table ${tableId} was not found, or you cannot see it`);
    const base = await requireBase(table.baseId, role, 'change it');
    return { table, base };
  };
  const field = (table: DraftTable, fieldId: number): TableFieldRow =>
    table.fields.find((candidate) => candidate.id === fieldId) ??
    problem(`field ${fieldId} is not an active field of table ${table.id} — re-read the schema`);
  const fresh = (kind: string, id: number, have: number, want: number) => {
    if (have !== want) problem(`${kind} ${id} is at revision ${have}, not ${want} — re-read it`);
  };
  const unique = (names: Iterable<string>, name: string, kind: string) => {
    if ([...names].includes(name)) problem(`a ${kind} named "${name}" already exists`);
  };

  const roleName = async (baseId: number, roleId: number | null): Promise<string> =>
    (await loadRoles(baseId))?.find((role) => role.id === roleId)?.name ?? `#${roleId}`;
  const levelOf = async (baseId: number, role: string, customRoleId: number | null): Promise<SchemaPlanAccessLevel> =>
    role === 'custom'
      ? { kind: 'custom', roleName: await roleName(baseId, customRoleId) }
      : role === 'owner' || role === 'builder' || role === 'editor' || role === 'viewer'
        ? { kind: 'role', role }
        : { kind: 'none' };
  const teamLevel = (base: DraftBase) =>
    base.visibility === 'team'
      ? levelOf(base.id, base.teamRole, base.teamCustomRoleId)
      : Promise.resolve<SchemaPlanAccessLevel>({ kind: 'none' });
  const audienceView = async (audience: TableFormAudience): Promise<SchemaPlanAudienceView> => {
    if (audience.type !== 'principals') return { kind: audience.type };
    const [people, teams] = await Promise.all([users(), groups()]);
    return {
      kind: 'principals',
      names: [
        ...audience.userIds.map((id) => people.find((user) => user.id === id)?.name ?? id),
        ...audience.groupIds.map((id) => teams.find((group) => group.id === id)?.name ?? `#${id}`),
      ],
    };
  };
  const ruleSummary = async (base: DraftBase, rules: TableAccessRules): Promise<SchemaPlanRuleSummary> => ({
    dashboards: rules.dashboards === 'all',
    tables: await Promise.all(
      rules.tables.map(async (rule) => {
        const fields = (await loadTable(rule.tableId))?.fields ?? [];
        const visible = new Set(rule.fields.filter((entry) => entry.access !== 'hidden').map((entry) => entry.fieldId));
        const hidden =
          rule.fieldDefault === 'hidden'
            ? fields.filter((candidate) => !visible.has(candidate.id)).length
            : rule.fields.filter((entry) => entry.access === 'hidden').length;
        return {
          table: base.tables.get(rule.tableId) ?? `#${rule.tableId}`,
          access: rule.access,
          limitedRows:
            (rule.rows ?? { type: 'all' }).type !== 'all' || (rule.editRows ?? { type: 'all' }).type !== 'all',
          hiddenFields: hidden,
        };
      }),
    ),
  });
  const checkRules = async (base: DraftBase, raw: unknown): Promise<TableAccessRules> => {
    const tables = [...base.tables.keys()].map((id) => ({ id }));
    const normalized = normalizeAccessRules(raw, { tables });
    if (!normalized.ok) return problem(normalized.error);
    const named = Array.isArray(object(raw).tables) ? (object(raw).tables as unknown[]) : [];
    const outside = named
      .map((rule) => object(rule).tableId)
      .filter((tableId) => typeof tableId === 'number' && !base.tables.has(tableId));
    if (outside.length > 0) problem(`the rules name table ${outside.join(', ')}, which is not a table of this Base`);
    return normalized.rules;
  };
  const baseRoles = async (base: DraftBase): Promise<DraftRole[]> => (await loadRoles(base.id)) ?? [];
  const addRole = async (base: DraftBase, role: DraftRole) => {
    const roles = await baseRoles(base);
    roleCache.set(base.id, Promise.resolve([...roles, role]));
  };
  const requireRole = async (base: DraftBase, roleId: number): Promise<DraftRole> =>
    (await baseRoles(base)).find((role) => role.id === roleId) ?? problem(`role ${roleId} is not a role of this Base`);

  const run = async (operation: SchemaPlanOperation, index: number): Promise<void> => {
    switch (operation.op) {
      case 'base.create': {
        const id = alloc(`$base:${operation.ref}`);
        const base: DraftBase = {
          id,
          name: operation.name,
          ownerId: reader.userId,
          level: 'owner',
          visibility: operation.visibility ?? 'private',
          teamRole: 'viewer',
          teamCustomRoleId: null,
          tables: new Map(),
          dashboards: new Set(),
          placeholder: true,
        };
        baseCache.set(id, Promise.resolve(base));
        grantCache.set(id, Promise.resolve({ users: new Map(), groups: new Map() }));
        roleCache.set(id, Promise.resolve([]));
        automationCache.set(id, Promise.resolve([]));
        refs.set(operation.ref, { kind: 'base', id });
        const table = placeholderTable(id, operation.defaultTableName ?? 'Table 1', operation.defaultTableRef);
        base.tables.set(table.id, table.name);
        if (base.visibility === 'team') {
          accessChanges.push({
            index,
            kind: 'team',
            base: base.name,
            before: { kind: 'none' },
            after: { kind: 'role', role: 'viewer' },
          });
        }
        return;
      }

      case 'base.update': {
        const base = await requireBase(operation.baseId ?? refId(operation.baseRef!), 'owner', 'change its settings');
        named(index, base.name);
        let teamCustomRoleId = base.teamCustomRoleId;
        if (operation.teamRole === 'custom') {
          teamCustomRoleId = (await requireRole(base, operation.teamCustomRoleId ?? refId(operation.roleRef!))).id;
        }
        const before = await teamLevel(base);
        if (operation.name !== undefined) base.name = operation.name;
        if (operation.visibility) base.visibility = operation.visibility;
        if (operation.teamRole) {
          base.teamRole = operation.teamRole;
          base.teamCustomRoleId = operation.teamRole === 'custom' ? teamCustomRoleId : null;
        }
        const after = await teamLevel(base);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          accessChanges.push({ index, kind: 'team', base: base.name, before, after });
        }
        return;
      }

      case 'table.create': {
        const base = await requireBase(operation.baseId ?? refId(operation.baseRef!), 'builder', 'change it');
        unique(base.tables.values(), operation.name, 'table');
        const table = placeholderTable(base.id, operation.name, operation.ref);
        base.tables.set(table.id, table.name);
        return;
      }

      case 'table.update': {
        const { table, base } = await requireTable(operation.tableId, 'builder');
        named(index, table.name);
        if (operation.name !== undefined && operation.name !== table.name) {
          unique(base.tables.values(), operation.name, 'table');
          table.name = operation.name;
          base.tables.set(table.id, operation.name);
        }
        return;
      }

      case 'field.create': {
        const { table } = await requireTable(operation.tableId ?? refId(operation.tableRef!), 'builder');
        unique(
          table.fields.map((candidate) => candidate.name),
          operation.name,
          'field',
        );
        const config = await check(() =>
          checkFieldConfig(source, table.id, operation.type, resolve(operation.config ?? {}) as TableFieldConfig),
        );
        const now = new Date(0).toISOString();
        const id = alloc(operation.ref ? `$field:${operation.ref}` : `field "${operation.name}"`);
        table.fields.push({
          id,
          table_id: table.id,
          name: operation.name,
          type: operation.type,
          required: operation.required === true,
          is_primary: false,
          config: JSON.stringify(config),
          position: table.fields.length,
          created_by: reader.userId,
          created_at: now,
          updated_at: now,
          archived_at: null,
        });
        if (operation.ref) refs.set(operation.ref, { kind: 'field', id });
        return;
      }

      case 'field.update': {
        const { table } = await requireTable(operation.tableId, 'builder');
        const target = field(table, operation.fieldId);
        named(index, target.name);
        if (operation.name !== undefined && operation.name !== target.name) {
          unique(
            table.fields.map((candidate) => candidate.name),
            operation.name,
            'field',
          );
        }
        if (operation.config !== undefined) {
          const config = await check(() =>
            checkFieldConfig(source, table.id, target.type, resolve(operation.config) as TableFieldConfig, target.id),
          );
          target.config = JSON.stringify(config);
        }
        if (operation.name !== undefined) target.name = operation.name;
        return;
      }

      case 'field.archive': {
        const { table } = await requireTable(operation.tableId, 'builder');
        const target = field(table, operation.fieldId);
        named(index, target.name);
        if (target.is_primary) problem('the primary field cannot be archived');
        table.fields = table.fields.filter((candidate) => candidate.id !== target.id);
        return;
      }

      case 'view.create': {
        const scope = operation.scope ?? 'shared';
        const { table } = await requireTable(
          operation.tableId ?? refId(operation.tableRef!),
          scope === 'shared' ? 'builder' : 'editor',
        );
        const type = operation.type ?? 'grid';
        const config = await check(() =>
          checkViewConfig(source, table.id, type, resolve(operation.config ?? {}), fullTableAccess(reader.userId)),
        );
        const id = alloc(operation.ref ? `$view:${operation.ref}` : `view "${operation.name}"`);
        table.views.push({ id, type, scope, config, revision: 1 });
        if (operation.ref) refs.set(operation.ref, { kind: 'view', id });
        return;
      }

      case 'view.update': {
        const loaded = (await loadTable(operation.tableId)) ?? problem(`table ${operation.tableId} was not found`);
        const view =
          loaded.views.find((candidate) => candidate.id === operation.viewId) ??
          problem(`view ${operation.viewId} is not a view of table ${operation.tableId} — re-read the schema`);
        await requireTable(operation.tableId, view.scope === 'shared' ? 'builder' : 'editor');
        fresh('view', view.id, view.revision, operation.revision);
        if (operation.type !== undefined || operation.config !== undefined) {
          const type = operation.type ?? view.type;
          view.config = await check(() =>
            checkViewConfig(
              source,
              loaded.id,
              type,
              operation.config === undefined ? view.config : resolve(operation.config),
              fullTableAccess(reader.userId),
            ),
          );
          view.type = type;
        }
        view.revision += 1;
        return;
      }

      case 'form.create': {
        const { table } = await requireTable(operation.tableId ?? refId(operation.tableRef!), 'builder');
        const formNames = await loadFormNames(table.id);
        unique(formNames, operation.name, 'form on this table');
        const audience = await check(() => checkFormAudience(source, operation.audience));
        await check(() =>
          checkFormConfig(source, table.id, resolve(operation.config) as unknown as TableFormConfig, audience),
        );
        const id = alloc(operation.ref ? `$form:${operation.ref}` : `form "${operation.name}"`);
        if (operation.ref) refs.set(operation.ref, { kind: 'form', id });
        formNames.add(operation.name);
        accessChanges.push({
          index,
          kind: 'form',
          form: operation.name,
          before: null,
          after: await audienceView(audience),
          published: operation.status === 'published',
        });
        return;
      }

      case 'form.update': {
        const form = (await loadForm(operation.formId)) ?? problem(`form ${operation.formId} was not found`);
        await requireTable(form.tableId, 'builder');
        named(index, form.name);
        fresh('form', form.id, form.revision, operation.revision);
        const audience =
          operation.audience === undefined
            ? form.audience
            : await check(() => checkFormAudience(source, operation.audience, form.audience));
        if (operation.config !== undefined || operation.audience !== undefined) {
          const config =
            operation.config === undefined ? form.config : (resolve(operation.config) as unknown as TableFormConfig);
          form.config = await check(() => checkFormConfig(source, form.tableId, config, audience));
        }
        const status = operation.status ?? form.status;
        if (JSON.stringify(audience) !== JSON.stringify(form.audience) || status !== form.status) {
          accessChanges.push({
            index,
            kind: 'form',
            form: operation.name ?? form.name,
            before: await audienceView(form.audience),
            after: await audienceView(audience),
            published: status === 'published',
          });
        }
        Object.assign(form, { audience, status, revision: form.revision + 1 });
        return;
      }

      case 'automation.create': {
        const { table, base } = await requireTable(operation.tableId ?? refId(operation.tableRef!), 'builder');
        const rules = (await loadAutomations(base.id)) ?? [];
        unique(
          rules.map((rule) => rule.name),
          operation.name,
          'automation in this Base',
        );
        const config = resolve(operation.config) as unknown as TableAutomationConfigInput;
        checkSchedule(operation.trigger, config);
        await check(() => checkAutomationConfig(source, base.id, table.id, operation.trigger, config));
        const id = alloc(operation.ref ? `$automation:${operation.ref}` : `automation "${operation.name}"`);
        if (operation.ref) refs.set(operation.ref, { kind: 'automation', id });
        rules.push({
          id,
          tableId: table.id,
          name: operation.name,
          trigger: operation.trigger,
          config: {},
          revision: 1,
        });
        automationCache.set(base.id, Promise.resolve(rules));
        return;
      }

      case 'automation.update': {
        const { table, base } = await requireTable(operation.tableId, 'builder');
        const rule =
          ((await loadAutomations(base.id)) ?? []).find(
            (candidate) => candidate.id === operation.automationId && candidate.tableId === table.id,
          ) ?? problem(`automation ${operation.automationId} is not a rule of table ${table.id}`);
        named(index, rule.name);
        fresh('automation', rule.id, rule.revision, operation.revision);
        const trigger = operation.trigger ?? rule.trigger;
        if (operation.config !== undefined || operation.trigger !== undefined) {
          const config = (operation.config === undefined
            ? rule.config
            : resolve(operation.config)) as unknown as TableAutomationConfigInput;
          const kept = keptWebhooksOnly(rule, config);
          checkSchedule(trigger, kept);
          await check(() => checkAutomationConfig(source, base.id, table.id, trigger, kept));
        }
        rule.revision += 1;
        return;
      }

      case 'dashboard.create': {
        const base = await requireBase(operation.baseId ?? refId(operation.baseRef!), 'builder', 'change it');
        unique(base.dashboards, operation.name, 'dashboard');
        await check(() => checkDashboardConfig(source, base.id, resolve(operation.config)));
        const id = alloc(operation.ref ? `$dashboard:${operation.ref}` : `dashboard "${operation.name}"`);
        base.dashboards.add(operation.name);
        dashboardCache.set(
          id,
          Promise.resolve({ id, baseId: base.id, name: operation.name, revision: 1, widgets: new Map() }),
        );
        if (operation.ref) refs.set(operation.ref, { kind: 'dashboard', id });
        return;
      }

      case 'dashboard.update': {
        const dashboard =
          (await loadDashboard(operation.dashboardId)) ?? problem(`dashboard ${operation.dashboardId} was not found`);
        await requireBase(dashboard.baseId, 'builder', 'change it');
        named(index, dashboard.name);
        fresh('dashboard', dashboard.id, dashboard.revision, operation.revision);
        if (operation.config !== undefined) {
          await check(() => checkDashboardConfig(source, dashboard.baseId, resolve(operation.config)));
        }
        dashboard.revision += 1;
        return;
      }

      case 'widget.create': {
        const dashboardId = operation.dashboardId ?? refId(operation.dashboardRef!);
        const dashboard = (await loadDashboard(dashboardId)) ?? problem(`dashboard ${dashboardId} was not found`);
        await requireBase(dashboard.baseId, 'builder', 'change it');
        const card = resolve(operation.card);
        const shaped = normalizeTableCardSpec(card);
        if (!shaped.ok) problem(shaped.error);
        const type = widgetTypeForCard((shaped as { card: Parameters<typeof widgetTypeForCard>[0] }).card);
        await check(() =>
          checkWidgetCard(source, dashboard.baseId, type, { version: 2, card: card as never }, tableOfCard(card)),
        );
        const id = alloc(operation.ref ? `widget "${operation.ref}"` : `widget "${operation.title}"`);
        dashboard.widgets.set(id, { type, revision: 1, title: operation.title });
        if (operation.ref) refs.set(operation.ref, { kind: 'widget', id });
        return;
      }

      case 'widget.update': {
        const dashboard =
          (await loadDashboard(operation.dashboardId)) ?? problem(`dashboard ${operation.dashboardId} was not found`);
        await requireBase(dashboard.baseId, 'builder', 'change it');
        const widget =
          dashboard.widgets.get(operation.widgetId) ??
          problem(`widget ${operation.widgetId} is not on dashboard ${dashboard.id}`);
        named(index, widget.title);
        fresh('widget', operation.widgetId, widget.revision, operation.revision);
        if (operation.card !== undefined) {
          const card = resolve(operation.card);
          await check(() =>
            checkWidgetCard(
              source,
              dashboard.baseId,
              widget.type,
              { version: 2, card: card as never },
              tableOfCard(card) ?? null,
            ),
          );
        }
        widget.revision += 1;
        return;
      }

      case 'widget.delete': {
        const dashboard =
          (await loadDashboard(operation.dashboardId)) ?? problem(`dashboard ${operation.dashboardId} was not found`);
        await requireBase(dashboard.baseId, 'builder', 'change it');
        const widget =
          dashboard.widgets.get(operation.widgetId) ??
          problem(`widget ${operation.widgetId} is not on dashboard ${dashboard.id}`);
        named(index, widget.title);
        dashboard.widgets.delete(operation.widgetId);
        return;
      }

      case 'role.create': {
        const base = await requireBase(operation.baseId ?? refId(operation.baseRef!), 'owner', 'change who has access');
        const roles = await baseRoles(base);
        unique(
          roles.map((role) => role.name),
          operation.name,
          'role',
        );
        const rules = await checkRules(base, resolve(operation.rules));
        const id = alloc(operation.ref ? `$role:${operation.ref}` : `role "${operation.name}"`);
        await addRole(base, { id, name: operation.name, rules, revision: 1 });
        if (operation.ref) refs.set(operation.ref, { kind: 'role', id });
        accessChanges.push({
          index,
          kind: 'role',
          role: operation.name,
          before: null,
          after: await ruleSummary(base, rules),
        });
        return;
      }

      case 'role.update': {
        const base = await requireBase(operation.baseId, 'owner', 'change who has access');
        const role = await requireRole(base, operation.roleId);
        named(index, role.name);
        fresh('role', role.id, role.revision, operation.revision);
        if (operation.rules !== undefined) {
          const rules = await checkRules(base, resolve(operation.rules));
          accessChanges.push({
            index,
            kind: 'role',
            role: operation.name ?? role.name,
            before: await ruleSummary(base, role.rules),
            after: await ruleSummary(base, rules),
          });
          role.rules = rules;
        }
        if (operation.name !== undefined) role.name = operation.name;
        role.revision += 1;
        return;
      }

      case 'member.set': {
        const base = await requireBase(operation.baseId ?? refId(operation.baseRef!), 'owner', 'change who has access');
        const grants = (await loadGrants(base.id)) ?? problem(`the members of Base ${base.id} cannot be read`);
        const customRoleId =
          operation.role === 'custom'
            ? (await requireRole(base, operation.customRoleId ?? refId(operation.roleRef!))).id
            : null;
        const after: SchemaPlanAccessLevel =
          operation.role === 'none' ? { kind: 'none' } : await levelOf(base.id, operation.role, customRoleId);
        if (operation.principal === 'user') {
          const userId = operation.userId!;
          const person =
            (await users()).find((user) => user.id === userId) ??
            problem(`user ${userId} is not an active internal user — look them up with tables_query directory.search`);
          named(index, person.name);
          if (userId === base.ownerId) problem(`${person.name} owns this Base; the owner's access cannot change here`);
          const held = grants.users.get(userId);
          if (!held && operation.role === 'none') problem(`${person.name} has no grant on this Base`);
          const before = held ? await levelOf(base.id, held.role, held.customRoleId) : { kind: 'none' as const };
          if (operation.role === 'none') grants.users.delete(userId);
          else grants.users.set(userId, { role: operation.role, customRoleId });
          accessChanges.push({
            index,
            kind: 'grant',
            base: base.name,
            principal: 'user',
            name: person.name,
            before,
            after,
          });
          return;
        }
        const groupId = operation.groupId!;
        const held = grants.groups.get(groupId);
        const visible = (await groups()).find((group) => group.id === groupId);
        // Granting needs a group you can see (D12); taking a grant away only narrows access.
        if (operation.role !== 'none' && !visible) {
          problem(`group ${groupId} was not found — look it up with tables_query directory.search`);
        }
        if (!held && operation.role === 'none') problem(`group ${groupId} has no grant on this Base`);
        const name = visible?.name ?? held?.name ?? `#${groupId}`;
        named(index, name);
        const before = held ? await levelOf(base.id, held.role, held.customRoleId) : { kind: 'none' as const };
        if (operation.role === 'none') grants.groups.delete(groupId);
        else grants.groups.set(groupId, { name, role: operation.role, customRoleId });
        accessChanges.push({ index, kind: 'grant', base: base.name, principal: 'group', name, before, after });
        return;
      }
    }
  };

  /** The schedule check the automation handler makes before the db sees the rule. */
  const checkSchedule = (trigger: TableAutomationTrigger, config: TableAutomationConfigInput) => {
    if (trigger !== 'schedule') return;
    const schedule = object(config).schedule as { cron: string; timezone: string } | undefined;
    const issue = schedule ? validateTablesSchedule(schedule) : 'A schedule rule requires a schedule';
    if (issue) problem(issue);
  };

  /** D16: a plan may keep a rule's existing webhook, never add or change one; the stored URL is restored. */
  const keptWebhooksOnly = (rule: DraftAutomation, config: TableAutomationConfigInput): TableAutomationConfigInput => {
    const actions = keepStoredWebhooks(object(config).actions, rule.config.actions) ?? problem(WEBHOOK_REFUSAL);
    return { ...config, actions } as TableAutomationConfigInput;
  };

  /**
   * Refs whose creating operation had a problem. What hangs off them is not
   * checked: it would only repeat the cause (and apply would skip it anyway).
   */
  const broken = new Set<string>();
  for (const [index, operation] of operations.entries()) {
    current = opLabel(operation, index + 1);
    const declares = [...shape.declared].filter(([, declaration]) => declaration.index === index).map(([ref]) => ref);
    if ((shape.needs[index] ?? []).some((need) => broken.has(need.ref))) {
      for (const ref of declares) broken.add(ref);
      continue;
    }
    const reported = problems.length;
    try {
      await run(operation, index);
    } catch (error) {
      if (!(error instanceof Reported)) throw error;
    }
    if (problems.length > reported) for (const ref of declares) broken.add(ref);
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, accessChanges, targetNames };
}

/** The table a card reads, when it names one. */
function tableOfCard(card: Record<string, unknown>): number | undefined {
  const tableId = object(card.source).tableId;
  return typeof tableId === 'number' ? tableId : undefined;
}
