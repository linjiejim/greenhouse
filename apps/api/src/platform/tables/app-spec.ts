/**
 * The app spec validator (docs/specs/20261011-tables-apps.md §2, D6) — the one
 * place an `AppSpec` is checked, for every writer: the builder's draft saves,
 * publish, the plan tool's draft check (slice AG passes a virtual schema), and
 * the gateway's runtime revalidation.
 *
 * Two layers:
 *  1. **Shape** (zod + the pure checks of `@greenhouse/types/apps`): ids match
 *     `APP_ID_PATTERN` and are unique in their scope, `APP_LIMITS`, `home` /
 *     role pages / `open_page` / every `roles` list name things that exist,
 *     `$page.<filterId>` references a filter of the same page, `open_url` is
 *     http(s) or an in-app `#/` link.
 *  2. **Schema** (against one Base, `AppSpecSchema`): every card's table is a
 *     live table of the Base; fields exist on it with a usable type; queries,
 *     `when` preconditions, embedded `TableCardSpec`s and page filters pass the
 *     db's own validators (`checkWidgetCard` / `checkDashboardConfig`, the same
 *     code dashboards use — never a copy); `set_fields` keys are editable for
 *     **every** role the action applies to (compiled with the one access
 *     compiler); `run_automation` names a button rule of the card's table;
 *     role rules only name tables of the Base.
 *
 * `validateAppSpec` returns the spec to store (embedded cards and filter
 * controls in their normalized form) or path-addressed errors.
 * `revalidateSpec` re-runs layer 2 on a stored spec and returns `AppIssue`s
 * — the cards / actions / filters a viewer should see as unavailable after the
 * schema moved on (D6: published versions are immutable, the schema is not).
 */

import { z } from 'zod';
import {
  checkDashboardConfig,
  checkWidgetCard,
  TablesValidationError,
  validateTableFieldValue,
  type DatabaseProvider,
  type TableFieldRow,
  type TablesSchemaSource,
} from '@greenhouse/db';
import {
  APP_ICONS,
  APP_ID_PATTERN,
  APP_LIMITS,
  rolesForPage,
  type AppCard,
  type AppDataSource,
  type AppIssue,
  type AppPage,
  type AppRecordAction,
  type AppRole,
  type AppSpec,
  type AppSpecError,
} from '@greenhouse/types/apps';
import {
  compileTableAccessScope,
  computeFieldAccess,
  normalizeAccessRules,
  type TableAccessRule,
  type TableAccessRules,
  type TableAccessSchemaFacts,
} from '@greenhouse/types/table-access';
import { normalizeTableCardSpec, widgetTypeForCard } from '@greenhouse/types/table-cards';
import {
  isComputedFieldType,
  TABLE_SYSTEM_FIELDS,
  type TableCardSpec,
  type TableFieldType,
  type TableFieldValueEntry,
  type TableFilterControl,
  type TableFilterGroup,
  type TableQuery,
  type TableSystemField,
} from '@greenhouse/types/tables';
import { toErrorMessage } from '@greenhouse/utils/error';

// ─── The schema a spec is checked against ─────────────────

/**
 * One Base as the validator reads it. The API loads the live one
 * (`loadAppSpecSchema`); the plan tool builds a virtual one from its draft.
 */
export interface AppSpecSchema {
  baseId: number;
  /** Live tables of the Base, their active fields and computed-field dependency edges. */
  facts: TableAccessSchemaFacts;
  /** What the db validators read (field rows with config, active users). */
  source: TablesSchemaSource;
  /** Automation rules with the `button` trigger, by table. */
  buttonRules: ReadonlyArray<{ id: number; tableId: number }>;
}

export async function loadAppSpecSchema(db: DatabaseProvider, baseId: number): Promise<AppSpecSchema> {
  const [facts, rules] = await Promise.all([db.tables.loadAccessFacts(baseId), db.tables.listAutomationRules(baseId)]);
  return {
    baseId,
    facts,
    source: db.tables.liveSchemaSource(),
    buttonRules: rules
      .filter((rule) => rule.trigger === 'button')
      .map((rule) => ({ id: rule.id, tableId: rule.table_id })),
  };
}

// ─── Layer 1: shape ───────────────────────────────────────

const id = z
  .string()
  .regex(APP_ID_PATTERN, 'must be 1-40 lowercase letters, digits, - or _ (starting with a letter or digit)');
const name = z.string().trim().min(1).max(APP_LIMITS.nameLength);
const fieldId = z.number().int().positive();
const fieldIds = z.array(fieldId).max(100);
const systemFields = z.array(z.enum(TABLE_SYSTEM_FIELDS)).max(TABLE_SYSTEM_FIELDS.length);
const roleKeys = z.array(id).max(APP_LIMITS.roles);
const objectOf = <T>(label: string) =>
  z.custom<T>(
    (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
const filterGroup = objectOf<TableFilterGroup>('a filter group');
const valueEntries = z.array(z.object({ fieldId, value: z.unknown() }).strict()).max(100);

const layout = z
  .object({
    x: z.number().int().min(0).max(1000),
    y: z.number().int().min(0).max(10_000),
    w: z.number().int().min(1).max(24),
    h: z.number().int().min(1).max(24),
  })
  .strict();

const dataSource = z
  .object({
    tableId: fieldId,
    query: objectOf<Omit<TableQuery, 'cursor' | 'limit'>>('query').optional(),
  })
  .strict();

const recordAction = z
  .object({
    id,
    label: name,
    roles: roleKeys.optional(),
    when: filterGroup.optional(),
    confirm: z.string().trim().min(1).max(500).optional(),
    do: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('set_fields'),
          values: valueEntries,
          inputFieldIds: fieldIds.optional(),
          requiredInputFieldIds: fieldIds.optional(),
        })
        .strict(),
      z.object({ type: z.literal('run_automation'), ruleId: fieldId }).strict(),
      z.object({ type: z.literal('delete') }).strict(),
    ]),
  })
  .strict();
const recordActions = z.array(recordAction).max(APP_LIMITS.actionsPerCard);

const detail = z
  .object({
    fieldIds,
    systemFields: systemFields.optional(),
    editableFieldIds: fieldIds.optional(),
    actions: recordActions.optional(),
    comments: z.boolean().optional(),
  })
  .strict();

const createSpec = z.object({ fieldIds, defaults: valueEntries.optional(), roles: roleKeys.optional() }).strict();

const button = z.discriminatedUnion('type', [
  z.object({ id, label: name, roles: roleKeys.optional(), type: z.literal('open_page'), pageId: id }).strict(),
  z
    .object({ id, label: name, roles: roleKeys.optional(), type: z.literal('open_url'), url: z.string().max(2000) })
    .strict(),
  z
    .object({
      id,
      label: name,
      roles: roleKeys.optional(),
      type: z.literal('create_record'),
      tableId: fieldId,
      fieldIds,
      defaults: valueEntries.optional(),
    })
    .strict(),
]);

const cardBase = { id, title: name.optional(), layout };
const embeddedCard = (kind: 'kpi' | 'chart' | 'pivot') =>
  z.object({ ...cardBase, kind: z.literal(kind), card: objectOf<TableCardSpec>('card') }).strict();

const card = z.discriminatedUnion('kind', [
  z
    .object({
      ...cardBase,
      kind: z.literal('records'),
      source: dataSource,
      fieldIds,
      systemFields: systemFields.optional(),
      display: z.enum(['table', 'list']).optional(),
      detail: detail.optional(),
      create: createSpec.optional(),
      actions: recordActions.optional(),
    })
    .strict(),
  z
    .object({
      ...cardBase,
      kind: z.literal('kanban'),
      source: dataSource,
      groupFieldId: fieldId,
      fieldIds,
      coverFieldId: fieldId.optional(),
      detail: detail.optional(),
      actions: recordActions.optional(),
      move: z.object({ roles: roleKeys.optional(), when: filterGroup.optional() }).strict().optional(),
    })
    .strict(),
  z
    .object({
      ...cardBase,
      kind: z.literal('calendar'),
      source: dataSource,
      startFieldId: fieldId,
      endFieldId: fieldId.optional(),
      fieldIds,
      detail: detail.optional(),
      actions: recordActions.optional(),
    })
    .strict(),
  z
    .object({
      ...cardBase,
      kind: z.literal('gallery'),
      source: dataSource,
      coverFieldId: fieldId.optional(),
      fieldIds,
      detail: detail.optional(),
      actions: recordActions.optional(),
    })
    .strict(),
  z
    .object({
      ...cardBase,
      kind: z.literal('form'),
      tableId: fieldId,
      fieldIds: fieldIds.min(1),
      defaults: valueEntries.optional(),
      submitLabel: z.string().trim().min(1).max(APP_LIMITS.nameLength).optional(),
      successMessage: z.string().trim().min(1).max(500).optional(),
      roles: roleKeys.optional(),
    })
    .strict(),
  embeddedCard('kpi'),
  embeddedCard('chart'),
  embeddedCard('pivot'),
  z.object({ ...cardBase, kind: z.literal('text'), markdown: z.string().max(APP_LIMITS.markdownLength) }).strict(),
  z
    .object({ ...cardBase, kind: z.literal('buttons'), buttons: z.array(button).min(1).max(APP_LIMITS.buttonsPerCard) })
    .strict(),
]);

const page = z
  .object({
    id,
    title: name,
    icon: z.enum(APP_ICONS).optional(),
    filters: z.array(objectOf<TableFilterControl>('filter control')).max(APP_LIMITS.filtersPerPage).optional(),
    cards: z.array(card).min(1).max(APP_LIMITS.cardsPerPage),
  })
  .strict();

const role = z
  .object({
    key: id,
    name,
    pages: z.union([z.literal('all'), z.array(id).min(1).max(APP_LIMITS.pages)]),
    tables: z.array(objectOf<TableAccessRule>('table rule')).max(100),
    canComment: z.boolean().optional(),
  })
  .strict();

export const appSpecSchema = z
  .object({
    version: z.literal(1),
    pages: z.array(page).min(1).max(APP_LIMITS.pages),
    roles: z.array(role).min(1).max(APP_LIMITS.roles),
    home: id.optional(),
    nav: z
      .object({ layout: z.enum(['tabs', 'sidebar']) })
      .strict()
      .optional(),
  })
  .strict();

// The zod output must stay assignable to the shared contract (a drifted schema fails typecheck).
type AssertAssignable<T extends AppSpec> = T;
export type AppSpecSchemaOutput = AssertAssignable<z.infer<typeof appSpecSchema>>;

// ─── Error collection ─────────────────────────────────────

interface Where {
  path: string;
  pageId?: string;
  cardId?: string;
  actionId?: string;
  filterId?: string;
  roleKey?: string;
}

class Problems {
  readonly list: AppSpecError[] = [];
  add(where: Where, message: string): void {
    this.list.push({ ...where, message });
  }
}

function zodPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>(
    (out, part) => (typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${String(part)}` : String(part)),
    '',
  );
}

function within(where: Where, suffix: string, extra: Partial<Where> = {}): Where {
  const path = suffix.startsWith('[') ? `${where.path}${suffix}` : where.path ? `${where.path}.${suffix}` : suffix;
  return { ...where, ...extra, path };
}

function messageOf(error: unknown): string {
  return error instanceof TablesValidationError ? error.message : toErrorMessage(error);
}

const PAGE_REF = /^\$page\.([a-z0-9][a-z0-9_-]{0,39})$/;

/** The `$page.<filterId>` ids a query's clauses reference. */
function pageRefs(query: AppDataSource['query'] | undefined): string[] {
  if (!query) return [];
  const groups = [query.where, ...(query.filters ?? [])];
  return groups.flatMap((group) =>
    (group?.clauses ?? []).flatMap((clause) => {
      const match = typeof clause.value === 'string' ? PAGE_REF.exec(clause.value) : null;
      return match ? [match[1]!] : [];
    }),
  );
}

/** The query with every `$page.*` clause removed (its value only exists at view time) — what a dry compile can check. */
function withoutPageRefs(query: AppDataSource['query'] | undefined): AppDataSource['query'] | undefined {
  if (!query) return query;
  const strip = (group: TableFilterGroup | undefined): TableFilterGroup | undefined => {
    if (!group || !Array.isArray(group.clauses)) return group;
    const clauses = group.clauses.filter(
      (clause) => !(typeof clause.value === 'string' && PAGE_REF.test(clause.value)),
    );
    return clauses.length > 0 ? { ...group, clauses } : undefined;
  };
  const where = strip(query.where);
  const filters = query.filters?.map(strip).filter((group): group is TableFilterGroup => group !== undefined);
  const out: Omit<TableQuery, 'cursor' | 'limit'> = { ...query };
  if (where) out.where = where;
  else delete out.where;
  if (filters && filters.length > 0) out.filters = filters;
  else delete out.filters;
  return out;
}

// ─── Pure checks (no schema) ──────────────────────────────

function cardActions(card: AppCard): Array<{ list: AppRecordAction[]; suffix: string }> {
  if (card.kind !== 'records' && card.kind !== 'kanban' && card.kind !== 'calendar' && card.kind !== 'gallery') {
    return [];
  }
  return [
    { list: card.actions ?? [], suffix: 'actions' },
    { list: card.detail?.actions ?? [], suffix: 'detail.actions' },
  ];
}

function pureChecks(spec: AppSpec, problems: Problems): void {
  const pageIds = new Set<string>();
  const roleKeysSeen = new Set(spec.roles.map((r) => r.key));
  if (Buffer.byteLength(JSON.stringify(spec), 'utf8') > APP_LIMITS.specBytes) {
    problems.add({ path: '' }, `The spec exceeds ${APP_LIMITS.specBytes} bytes`);
  }
  const knownRoles = (roles: readonly string[] | undefined, where: Where) => {
    for (const [index, key] of (roles ?? []).entries()) {
      if (!roleKeysSeen.has(key)) problems.add(within(where, `roles[${index}]`), `Unknown role "${key}"`);
    }
  };

  const seenRoles = new Set<string>();
  for (const [index, entry] of spec.roles.entries()) {
    const where: Where = { path: `roles[${index}]`, roleKey: entry.key };
    if (seenRoles.has(entry.key)) problems.add(within(where, 'key'), `Role "${entry.key}" is defined twice`);
    seenRoles.add(entry.key);
  }

  for (const [pageIndex, entry] of spec.pages.entries()) {
    const pageWhere: Where = { path: `pages[${pageIndex}]`, pageId: entry.id };
    if (pageIds.has(entry.id)) problems.add(within(pageWhere, 'id'), `Page "${entry.id}" is defined twice`);
    pageIds.add(entry.id);
    const filterIds = new Set<string>();
    for (const [filterIndex, control] of (entry.filters ?? []).entries()) {
      const controlId = typeof control.id === 'string' ? control.id : '';
      if (!APP_ID_PATTERN.test(controlId)) {
        problems.add(
          within(pageWhere, `filters[${filterIndex}].id`),
          'Filter ids must be 1-40 lowercase letters, digits, - or _ (they are referenced as $page.<id>)',
        );
      }
      if (filterIds.has(controlId)) {
        problems.add(within(pageWhere, `filters[${filterIndex}].id`), `Filter "${controlId}" is defined twice`);
      }
      filterIds.add(controlId);
    }
    const cardIds = new Set<string>();
    for (const [cardIndex, item] of entry.cards.entries()) {
      const cardWhere = within(pageWhere, `cards[${cardIndex}]`, { cardId: item.id });
      if (cardIds.has(item.id))
        problems.add(within(cardWhere, 'id'), `Card "${item.id}" is defined twice on this page`);
      cardIds.add(item.id);

      // Actions: unique per card across row actions and detail actions.
      const actionIds = new Set<string>();
      for (const { list, suffix } of cardActions(item)) {
        for (const [actionIndex, action] of list.entries()) {
          const actionWhere = within(cardWhere, `${suffix}[${actionIndex}]`, { actionId: action.id });
          if (actionIds.has(action.id)) {
            problems.add(within(actionWhere, 'id'), `Action "${action.id}" is defined twice on this card`);
          }
          actionIds.add(action.id);
          knownRoles(action.roles, actionWhere);
          if (pageRefs({ where: action.when }).length > 0) {
            problems.add(within(actionWhere, 'when'), 'A precondition cannot use $page values (only card queries can)');
          }
          if (action.do.type === 'set_fields') {
            const inputs = new Set(action.do.inputFieldIds ?? []);
            for (const [i, required] of (action.do.requiredInputFieldIds ?? []).entries()) {
              if (!inputs.has(required)) {
                problems.add(
                  within(actionWhere, `do.requiredInputFieldIds[${i}]`),
                  `Required input field ${required} is not one of the action's input fields`,
                );
              }
            }
            if (action.do.values.length === 0 && inputs.size === 0) {
              problems.add(within(actionWhere, 'do'), 'A set_fields action needs values or input fields');
            }
          }
        }
      }
      if (item.kind === 'records') knownRoles(item.create?.roles, within(cardWhere, 'create'));
      if (item.kind === 'kanban') {
        knownRoles(item.move?.roles, within(cardWhere, 'move'));
        if (pageRefs({ where: item.move?.when }).length > 0) {
          problems.add(
            within(cardWhere, 'move.when'),
            'A precondition cannot use $page values (only card queries can)',
          );
        }
      }
      if (item.kind === 'form') knownRoles(item.roles, cardWhere);
      if (item.kind === 'buttons') {
        const buttonIds = new Set<string>();
        for (const [buttonIndex, entryButton] of item.buttons.entries()) {
          const buttonWhere = within(cardWhere, `buttons[${buttonIndex}]`, { actionId: entryButton.id });
          if (buttonIds.has(entryButton.id)) {
            problems.add(within(buttonWhere, 'id'), `Button "${entryButton.id}" is defined twice on this card`);
          }
          buttonIds.add(entryButton.id);
          knownRoles(entryButton.roles, buttonWhere);
          if (entryButton.type === 'open_url' && !/^(https?:\/\/[^\s]+|#\/[^\s]*)$/i.test(entryButton.url)) {
            problems.add(within(buttonWhere, 'url'), 'Links must be http(s) URLs or in-app #/ links');
          }
        }
      }
      const queries: Array<{ query: AppDataSource['query']; suffix: string }> =
        item.kind === 'records' || item.kind === 'kanban' || item.kind === 'calendar' || item.kind === 'gallery'
          ? [{ query: item.source.query, suffix: 'source.query' }]
          : item.kind === 'kpi' || item.kind === 'chart' || item.kind === 'pivot'
            ? [{ query: item.card.source?.query, suffix: 'card.source.query' }]
            : [];
      for (const { query, suffix } of queries) {
        for (const ref of pageRefs(query)) {
          if (!filterIds.has(ref)) {
            problems.add(within(cardWhere, suffix), `$page.${ref} does not name a filter of this page`);
          }
        }
      }
    }
  }

  // Cross-references once every page id is known.
  if (spec.home !== undefined && !pageIds.has(spec.home)) {
    problems.add({ path: 'home' }, `Home page "${spec.home}" does not exist`);
  }
  for (const [index, entry] of spec.roles.entries()) {
    if (entry.pages === 'all') continue;
    for (const [i, pageId] of entry.pages.entries()) {
      if (!pageIds.has(pageId)) {
        problems.add({ path: `roles[${index}].pages[${i}]`, roleKey: entry.key }, `Page "${pageId}" does not exist`);
      }
    }
  }
  for (const [pageIndex, entry] of spec.pages.entries()) {
    for (const [cardIndex, item] of entry.cards.entries()) {
      if (item.kind !== 'buttons') continue;
      for (const [buttonIndex, entryButton] of item.buttons.entries()) {
        if (entryButton.type === 'open_page' && !pageIds.has(entryButton.pageId)) {
          problems.add(
            {
              path: `pages[${pageIndex}].cards[${cardIndex}].buttons[${buttonIndex}].pageId`,
              pageId: entry.id,
              cardId: item.id,
              actionId: entryButton.id,
            },
            `Page "${entryButton.pageId}" does not exist`,
          );
        }
      }
    }
  }
}

// ─── Layer 2: against the Base ────────────────────────────

const DEFAULT_TOKEN_TYPES: Readonly<Record<string, ReadonlySet<TableFieldType>>> = {
  $me: new Set(['user', 'multi_user']),
  $today: new Set(['date']),
  $now: new Set(['datetime']),
};

interface SchemaChecker {
  run(spec: AppSpec): Promise<{ filters: Map<string, TableFilterControl[]>; cards: Map<string, TableCardSpec> }>;
}

function schemaChecker(schema: AppSpecSchema, problems: Problems): SchemaChecker {
  const liveTables = new Set(schema.facts.tables.map((table) => table.id));
  const fieldCache = new Map<number, Promise<Map<number, TableFieldRow>>>();
  const fieldsOf = (tableId: number) => {
    let found = fieldCache.get(tableId);
    if (!found) {
      found = schema.source.fields(tableId).then((rows) => new Map(rows.map((row) => [row.id, row])));
      fieldCache.set(tableId, found);
    }
    return found;
  };

  // Each role's compiled view, once.
  const roleRules = new Map<string, TableAccessRules>();
  const roleAccess = new Map<string, ReturnType<typeof computeFieldAccess>>();
  const rulesOf = (entry: AppRole): TableAccessRules => {
    let rules = roleRules.get(entry.key);
    if (!rules) {
      const normalized = normalizeAccessRules({ version: 1, tables: entry.tables, dashboards: 'none' }, schema.facts);
      rules = normalized.ok ? normalized.rules : { version: 1, tables: [], dashboards: 'none' };
      roleRules.set(entry.key, rules);
      roleAccess.set(entry.key, computeFieldAccess(rules, schema.facts));
    }
    return rules;
  };
  const editableFor = (entry: AppRole, tableId: number): Set<number> | undefined => {
    const rules = rulesOf(entry);
    const scope = compileTableAccessScope(rules, tableId, schema.facts, 'app-spec', roleAccess.get(entry.key));
    return scope ? new Set(scope.editableFieldIds) : undefined;
  };

  const tableOk = (tableId: number, where: Where): boolean => {
    if (liveTables.has(tableId)) return true;
    problems.add(where, `Table ${tableId} is not a table of this Base`);
    return false;
  };

  const field = async (
    tableId: number,
    id: number,
    where: Where,
    rule?: { types?: readonly TableFieldType[]; writable?: boolean; label?: string },
  ): Promise<TableFieldRow | undefined> => {
    const found = (await fieldsOf(tableId)).get(id);
    if (!found) {
      problems.add(where, `Field ${id} does not exist on table ${tableId}`);
      return undefined;
    }
    if (rule?.writable && isComputedFieldType(found.type)) {
      problems.add(where, `Field "${found.name}" is computed and cannot be written`);
      return undefined;
    }
    if (rule?.types && !rule.types.includes(found.type)) {
      problems.add(where, `${rule.label ?? 'This'} needs a ${rule.types.join(' / ')} field, not "${found.name}"`);
      return undefined;
    }
    return found;
  };

  const fieldList = async (tableId: number, ids: readonly number[], where: Where, writable = false) => {
    for (const [index, id] of ids.entries()) await field(tableId, id, within(where, `[${index}]`), { writable });
  };

  const values = async (tableId: number, entries: readonly TableFieldValueEntry[], where: Where) => {
    const activeUsers = await schema.source.activeUserIds();
    for (const [index, entry] of entries.entries()) {
      const at = within(where, `[${index}]`);
      const found = await field(tableId, entry.fieldId, within(at, 'fieldId'), { writable: true });
      if (!found) continue;
      if (found.type === 'attachment') {
        problems.add(at, `Attachment field "${found.name}" cannot have a fixed value`);
        continue;
      }
      if (typeof entry.value === 'string' && Object.hasOwn(DEFAULT_TOKEN_TYPES, entry.value)) {
        if (!DEFAULT_TOKEN_TYPES[entry.value]!.has(found.type)) {
          problems.add(at, `${entry.value} cannot fill field "${found.name}"`);
        }
        continue;
      }
      try {
        validateTableFieldValue(found, entry.value, activeUsers);
      } catch (error) {
        problems.add(at, messageOf(error));
      }
    }
  };

  /** Compile a predicate / query and check columns through the db's own card validator (records kind). */
  const query = async (
    tableId: number,
    raw: AppDataSource['query'] | undefined,
    where: Where,
    columns: { fieldIds?: number[]; systemFields?: TableSystemField[] } = {},
  ) => {
    const cardSpec: TableCardSpec = {
      kind: 'records',
      source: { tableId, ...(raw ? { query: withoutPageRefs(raw) } : {}) },
      ...(columns.fieldIds ? { fieldIds: columns.fieldIds } : {}),
      ...(columns.systemFields ? { systemFields: columns.systemFields } : {}),
    };
    try {
      await checkWidgetCard(schema.source, schema.baseId, 'records', { card: cardSpec }, undefined);
    } catch (error) {
      problems.add(where, messageOf(error));
    }
  };

  const condition = (tableId: number, group: TableFilterGroup | undefined, where: Where) =>
    group ? query(tableId, { where: group }, where) : Promise.resolve();

  const actionList = async (
    spec: AppSpec,
    pageId: string,
    tableId: number,
    list: readonly AppRecordAction[],
    where: Where,
  ) => {
    for (const [index, action] of list.entries()) {
      const at = within(where, `[${index}]`, { actionId: action.id });
      await condition(tableId, action.when, within(at, 'when'));
      if (action.do.type === 'run_automation') {
        const ruleId = action.do.ruleId;
        if (!schema.buttonRules.some((rule) => rule.id === ruleId && rule.tableId === tableId)) {
          problems.add(within(at, 'do.ruleId'), `Automation ${ruleId} is not a button rule of this card's table`);
        }
        continue;
      }
      if (action.do.type !== 'set_fields') continue;
      await values(tableId, action.do.values, within(at, 'do.values'));
      await fieldList(tableId, action.do.inputFieldIds ?? [], within(at, 'do.inputFieldIds'), true);
      // Every key written must be editable for every role the action applies to.
      const keys = [
        ...new Set([...action.do.values.map((entry) => entry.fieldId), ...(action.do.inputFieldIds ?? [])]),
      ];
      const applies = action.roles
        ? spec.roles.filter((entry) => action.roles!.includes(entry.key))
        : rolesForPage(spec, pageId);
      for (const entry of applies) {
        const editable = editableFor(entry, tableId);
        const blocked = keys.filter((key) => !editable?.has(key));
        if (blocked.length > 0) {
          problems.add(
            within(at, 'do'),
            `Role "${entry.key}" cannot edit field${blocked.length > 1 ? 's' : ''} ${blocked.join(', ')} on table ${tableId}`,
          );
        }
      }
    }
  };

  const recordsLike = async (spec: AppSpec, pageId: string, item: AppCard, where: Where) => {
    if (item.kind !== 'records' && item.kind !== 'kanban' && item.kind !== 'calendar' && item.kind !== 'gallery')
      return;
    const tableId = item.source.tableId;
    if (!tableOk(tableId, within(where, 'source.tableId'))) return;
    await query(tableId, item.source.query, within(where, 'source.query'), {
      fieldIds: item.fieldIds,
      ...(item.kind === 'records' && item.systemFields ? { systemFields: item.systemFields } : {}),
    });
    if (item.kind === 'kanban') {
      await field(tableId, item.groupFieldId, within(where, 'groupFieldId'), {
        types: ['single_select', 'user'],
        label: 'A kanban lane',
      });
      if (item.move) await condition(tableId, item.move.when, within(where, 'move.when'));
    }
    if (item.kind === 'calendar') {
      await field(tableId, item.startFieldId, within(where, 'startFieldId'), {
        types: ['date', 'datetime'],
        label: 'A calendar',
      });
      if (item.endFieldId !== undefined) {
        await field(tableId, item.endFieldId, within(where, 'endFieldId'), {
          types: ['date', 'datetime'],
          label: 'A calendar',
        });
      }
    }
    if ((item.kind === 'kanban' || item.kind === 'gallery') && item.coverFieldId !== undefined) {
      await field(tableId, item.coverFieldId, within(where, 'coverFieldId'), {
        types: ['attachment'],
        label: 'A cover',
      });
    }
    if (item.detail) {
      await fieldList(tableId, item.detail.fieldIds, within(where, 'detail.fieldIds'));
      await fieldList(tableId, item.detail.editableFieldIds ?? [], within(where, 'detail.editableFieldIds'), true);
      await actionList(spec, pageId, tableId, item.detail.actions ?? [], within(where, 'detail.actions'));
    }
    await actionList(spec, pageId, tableId, item.actions ?? [], within(where, 'actions'));
    if (item.kind === 'records' && item.create) {
      await fieldList(tableId, item.create.fieldIds, within(where, 'create.fieldIds'), true);
      await values(tableId, item.create.defaults ?? [], within(where, 'create.defaults'));
    }
  };

  return {
    async run(spec) {
      const filters = new Map<string, TableFilterControl[]>();
      const cards = new Map<string, TableCardSpec>();

      for (const [index, entry] of spec.roles.entries()) {
        const where: Where = { path: `roles[${index}].tables`, roleKey: entry.key };
        const normalized = normalizeAccessRules({ version: 1, tables: entry.tables, dashboards: 'none' });
        if (!normalized.ok) {
          problems.add(where, normalized.error);
          continue;
        }
        for (const [ruleIndex, rule] of normalized.rules.tables.entries()) {
          tableOk(rule.tableId, within(where, `[${ruleIndex}].tableId`));
        }
      }

      for (const [pageIndex, entry] of spec.pages.entries()) {
        const pageWhere: Where = { path: `pages[${pageIndex}]`, pageId: entry.id };
        const controls: TableFilterControl[] = [];
        for (const [filterIndex, control] of (entry.filters ?? []).entries()) {
          const where = within(pageWhere, `filters[${filterIndex}]`, {
            filterId: typeof control.id === 'string' ? control.id : undefined,
          });
          try {
            const checked = await checkDashboardConfig(schema.source, schema.baseId, {
              version: 1,
              filters: [control],
            });
            controls.push(...checked.filters);
          } catch (error) {
            problems.add(where, messageOf(error));
          }
        }
        filters.set(entry.id, controls);

        for (const [cardIndex, item] of entry.cards.entries()) {
          const where = within(pageWhere, `cards[${cardIndex}]`, { cardId: item.id });
          switch (item.kind) {
            case 'records':
            case 'kanban':
            case 'calendar':
            case 'gallery':
              await recordsLike(spec, entry.id, item, where);
              break;
            case 'form':
              if (!tableOk(item.tableId, within(where, 'tableId'))) break;
              await fieldList(item.tableId, item.fieldIds, within(where, 'fieldIds'), true);
              await values(item.tableId, item.defaults ?? [], within(where, 'defaults'));
              break;
            case 'kpi':
            case 'chart':
            case 'pivot': {
              const shaped = normalizeTableCardSpec(item.card);
              if (!shaped.ok) {
                problems.add(within(where, 'card'), shaped.error);
                break;
              }
              if (shaped.card.kind !== item.kind) {
                problems.add(within(where, 'card.kind'), `A ${item.kind} card must embed a ${item.kind} spec`);
                break;
              }
              const embedded = { ...shaped.card, source: shaped.card.source && { ...shaped.card.source } };
              if (embedded.source?.query) embedded.source.query = withoutPageRefs(embedded.source.query);
              try {
                await checkWidgetCard(
                  schema.source,
                  schema.baseId,
                  widgetTypeForCard(embedded),
                  { card: embedded },
                  undefined,
                );
                cards.set(`${entry.id}/${item.id}`, shaped.card);
              } catch (error) {
                problems.add(within(where, 'card'), messageOf(error));
              }
              break;
            }
            case 'buttons':
              for (const [buttonIndex, entryButton] of item.buttons.entries()) {
                if (entryButton.type !== 'create_record') continue;
                const at = within(where, `buttons[${buttonIndex}]`, { actionId: entryButton.id });
                if (!tableOk(entryButton.tableId, within(at, 'tableId'))) continue;
                await fieldList(entryButton.tableId, entryButton.fieldIds, within(at, 'fieldIds'), true);
                await values(entryButton.tableId, entryButton.defaults ?? [], within(at, 'defaults'));
              }
              break;
            case 'text':
              break;
          }
        }
      }
      return { filters, cards };
    },
  };
}

// ─── Entry points ─────────────────────────────────────────

export type AppSpecShapeResult = { ok: true; spec: AppSpec } | { ok: false; errors: AppSpecError[] };

/** Layer 1 only: the shape and the pure checks. No schema needed. */
export function parseAppSpec(raw: unknown): AppSpecShapeResult {
  const parsed = appSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({ path: zodPath(issue.path), message: issue.message })),
    };
  }
  const spec: AppSpec = parsed.data;
  const problems = new Problems();
  pureChecks(spec, problems);
  return problems.list.length > 0 ? { ok: false, errors: problems.list } : { ok: true, spec };
}

export type AppSpecValidation =
  | { ok: true; spec: AppSpec }
  /** `spec` is present when the shape is fine and only schema checks failed (a draft may still be saved). */
  | { ok: false; errors: AppSpecError[]; spec?: AppSpec };

/**
 * Shape, pure checks and the schema checks against one Base. On success the
 * spec carries embedded cards and page filters in their normalized form —
 * store `JSON.stringify(result.spec)`.
 */
export async function validateAppSpec(raw: unknown, schema: AppSpecSchema): Promise<AppSpecValidation> {
  const shaped = parseAppSpec(raw);
  if (!shaped.ok) return shaped;
  const problems = new Problems();
  const normalized = await schemaChecker(schema, problems).run(shaped.spec);
  const spec: AppSpec = {
    ...shaped.spec,
    pages: shaped.spec.pages.map(
      (entry): AppPage => ({
        ...entry,
        ...(entry.filters ? { filters: normalized.filters.get(entry.id) ?? entry.filters } : {}),
        cards: entry.cards.map((item): AppCard => {
          if (item.kind !== 'kpi' && item.kind !== 'chart' && item.kind !== 'pivot') return item;
          return { ...item, card: normalized.cards.get(`${entry.id}/${item.id}`) ?? item.card };
        }),
      }),
    ),
  };
  return problems.list.length > 0 ? { ok: false, errors: problems.list, spec } : { ok: true, spec };
}

/**
 * D6 runtime degradation: re-run the schema checks of a stored (published)
 * spec against today's schema. Every problem becomes an issue on the page,
 * card, action or filter it sits in — the gateway serves those as unavailable
 * and managers see "v3 references a deleted field". Role-rule problems are not
 * issues: the access compiler already fails them closed.
 */
export async function revalidateSpec(spec: AppSpec, schema: AppSpecSchema): Promise<AppIssue[]> {
  const problems = new Problems();
  await schemaChecker(schema, problems).run(spec);
  const issues: AppIssue[] = [];
  const seen = new Set<string>();
  for (const problem of problems.list) {
    if (!problem.pageId) continue;
    const issue: AppIssue = {
      pageId: problem.pageId,
      ...(problem.cardId ? { cardId: problem.cardId } : {}),
      ...(problem.actionId ? { actionId: problem.actionId } : {}),
      ...(problem.filterId ? { filterId: problem.filterId } : {}),
      message: problem.message,
    };
    const key = JSON.stringify(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return issues;
}

/** Parse stored spec text (draft or a verified version). Undefined when it is not a valid spec shape. */
export function parseStoredAppSpec(text: string): AppSpec | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const shaped = appSpecSchema.safeParse(raw);
  return shaped.success ? shaped.data : undefined;
}
