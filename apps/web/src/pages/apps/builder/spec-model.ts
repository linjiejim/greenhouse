/**
 * The app builder's pure model: what the Base offers a builder (its tables,
 * fields and button rules), sensible starting points for every card kind, and
 * the edits a builder makes to an `AppSpec` — each a function from spec to
 * spec, so the canvas, the panels and the tests share one implementation.
 *
 * Edits keep the spec in a shape the server will store (spec §2): a page
 * keeps at least one card, the app at least one page and one role, ids stay
 * unique slugs, and deleting a page, a role or a page filter also removes what
 * pointed at it — or, where removing it would silently widen or break access,
 * reports what blocks it instead. The server validator stays the authority
 * (schema checks, editability per role); the builder shows its errors.
 */

import {
  APP_BUILDER_SEGMENT,
  APP_CARD_KINDS,
  APP_ID_PATTERN,
  APP_LIMITS,
  type AppButton,
  type AppCard,
  type AppCardKind,
  type AppCardLayout,
  type AppDataSource,
  type AppPage,
  type AppRecordAction,
  type AppRole,
  type AppSpec,
} from '@greenhouse/types/apps';
import type { TableCardSpec, TableFieldType, TableFilterGroup } from '@greenhouse/types/tables';
import type { TableDefinition, TableField } from '../../../lib/api/tables';
import { isComputedField } from '../../../components/tables/field-types';

// ─── What the Base offers ─────────────────────────────────

export interface BuilderButtonRule {
  id: number;
  tableId: number;
  name: string;
  enabled: boolean;
}

export interface BuilderSchema {
  baseId: number;
  tables: TableDefinition[];
  /** Active fields per table, in schema order. */
  fieldsByTable: ReadonlyMap<number, TableField[]>;
  /** Automation rules with the `button` trigger (what `run_automation` may name). */
  buttonRules: readonly BuilderButtonRule[];
}

export function fieldsOf(schema: BuilderSchema, tableId: number | undefined): TableField[] {
  return tableId === undefined ? [] : (schema.fieldsByTable.get(tableId) ?? []);
}

export function tableName(schema: BuilderSchema, tableId: number | undefined): string | undefined {
  return schema.tables.find((table) => table.id === tableId)?.name;
}

/** Stored fields (never formulas, rollups or lookups) — what a form, a create or an action may write. */
export function writableFields(fields: readonly TableField[]): TableField[] {
  return fields.filter((field) => !isComputedField(field));
}

/** The primary field first, the rest in schema order. */
export function primaryFirst(fields: readonly TableField[]): TableField[] {
  return [...fields.filter((field) => field.is_primary), ...fields.filter((field) => !field.is_primary)];
}

const LANE_TYPES: readonly TableFieldType[] = ['single_select', 'user'];
const DATE_TYPES: readonly TableFieldType[] = ['date', 'datetime'];

export function laneFields(fields: readonly TableField[]): TableField[] {
  return fields.filter((field) => LANE_TYPES.includes(field.type));
}

export function dateFields(fields: readonly TableField[]): TableField[] {
  return fields.filter((field) => DATE_TYPES.includes(field.type));
}

export function attachmentFields(fields: readonly TableField[]): TableField[] {
  return fields.filter((field) => field.type === 'attachment');
}

// ─── Ids ──────────────────────────────────────────────────

/**
 * A slug id (`APP_ID_PATTERN`) from a name, unique among `taken`. Names
 * without ASCII letters (中文) fall back to `fallback`; collisions get `-2`,
 * `-3`… `reserved` ids are never returned (a page may not be called `edit`).
 */
export function slugId(
  seed: string,
  taken: Iterable<string>,
  fallback: string,
  reserved: readonly string[] = [],
): string {
  const slug = seed
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 30);
  const base = APP_ID_PATTERN.test(slug) ? slug : fallback;
  const used = new Set([...taken, ...reserved]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Declared action id → its label, across every card of the spec (row and
 * detail actions) — how usage names what people ran. An id used with
 * different labels on several cards lists them all.
 */
export function actionLabelsById(spec: AppSpec): Map<string, string> {
  const labels = new Map<string, string[]>();
  for (const page of spec.pages) {
    for (const card of page.cards) {
      if (!isRecordsLike(card)) continue;
      for (const action of [...(card.actions ?? []), ...(card.detail?.actions ?? [])]) {
        const known = labels.get(action.id) ?? [];
        if (action.label && !known.includes(action.label)) labels.set(action.id, [...known, action.label]);
      }
    }
  }
  return new Map([...labels].map(([id, names]) => [id, names.join(' / ')]));
}

/** Every action id on a card (row actions and detail actions share one namespace). */
export function cardActionIds(card: AppCard): string[] {
  if (!isRecordsLike(card)) return [];
  return [...(card.actions ?? []), ...(card.detail?.actions ?? [])].map((action) => action.id);
}

// ─── Card kinds ───────────────────────────────────────────

export type RecordsLikeCard = Extract<AppCard, { kind: 'records' | 'kanban' | 'calendar' | 'gallery' }>;
export type EmbeddedCard = Extract<AppCard, { kind: 'kpi' | 'chart' | 'pivot' }>;

export function isRecordsLike(card: AppCard): card is RecordsLikeCard {
  return card.kind === 'records' || card.kind === 'kanban' || card.kind === 'calendar' || card.kind === 'gallery';
}

export function isEmbedded(card: AppCard): card is EmbeddedCard {
  return card.kind === 'kpi' || card.kind === 'chart' || card.kind === 'pivot';
}

/** The table a card reads or writes, if any. */
export function cardTableId(card: AppCard): number | undefined {
  if (isRecordsLike(card)) return card.source.tableId;
  if (card.kind === 'form') return card.tableId;
  if (isEmbedded(card)) return card.card.source?.tableId;
  return undefined;
}

/** Grid size a new card of each kind starts with (12 columns). */
export const CARD_SIZES: Readonly<Record<AppCardKind, { w: number; h: number }>> = {
  records: { w: 12, h: 6 },
  kanban: { w: 12, h: 7 },
  calendar: { w: 12, h: 8 },
  gallery: { w: 12, h: 6 },
  form: { w: 6, h: 7 },
  kpi: { w: 3, h: 3 },
  chart: { w: 6, h: 5 },
  pivot: { w: 6, h: 5 },
  text: { w: 12, h: 2 },
  buttons: { w: 6, h: 2 },
  custom: { w: 12, h: 6 },
  external: { w: 6, h: 5 },
};

/**
 * The kinds the catalog offers. Phase 2's `custom` (slice S) and `external`
 * (slice SRC) join when their editors do — until then a builder cannot add a
 * card nothing can configure.
 */
export const CATALOG_CARD_KINDS: readonly AppCardKind[] = APP_CARD_KINDS.filter((kind) => kind !== 'external');

/** Below everything already on the page, full left. */
export function nextCardLayout(cards: readonly AppCard[], kind: AppCardKind): AppCardLayout {
  const bottom = cards.reduce((max, card) => Math.max(max, card.layout.y + card.layout.h), 0);
  return { x: 0, y: bottom, ...CARD_SIZES[kind] };
}

/** Why a card kind cannot be added to this Base yet (none = it can). */
export type CatalogBlocker = 'noTables' | 'noLaneField' | 'noDateField' | 'noWritableField';

function eligible(kind: AppCardKind, fields: readonly TableField[]): boolean {
  if (kind === 'kanban') return laneFields(fields).length > 0;
  if (kind === 'calendar') return dateFields(fields).length > 0;
  if (kind === 'form') return writableFields(fields).length > 0;
  return true;
}

const NEEDS_TABLE: ReadonlySet<AppCardKind> = new Set([
  'records',
  'kanban',
  'calendar',
  'gallery',
  'form',
  'kpi',
  'chart',
  'pivot',
  'custom',
]);

/** Tables a card of `kind` can read (a kanban needs a lane field, a calendar a date field…). */
export function eligibleTables(kind: AppCardKind, schema: BuilderSchema): TableDefinition[] {
  if (!NEEDS_TABLE.has(kind)) return [];
  return schema.tables.filter((table) => eligible(kind, fieldsOf(schema, table.id)));
}

export function catalogBlocker(kind: AppCardKind, schema: BuilderSchema): CatalogBlocker | null {
  if (!NEEDS_TABLE.has(kind)) return null;
  if (schema.tables.length === 0) return 'noTables';
  if (eligibleTables(kind, schema).length > 0) return null;
  if (kind === 'kanban') return 'noLaneField';
  if (kind === 'calendar') return 'noDateField';
  return 'noWritableField';
}

function firstFieldIds(fields: readonly TableField[], count: number, exclude: readonly number[] = []): number[] {
  return primaryFirst(fields)
    .filter((field) => !exclude.includes(field.id) && field.type !== 'attachment')
    .slice(0, count)
    .map((field) => field.id);
}

/** The aggregate a new chart / pivot groups by: a choice field, else the month a record was created. */
function defaultGroupBy(fields: readonly TableField[]): NonNullable<TableCardSpec['aggregate']>['groupBy'] {
  const choice =
    fields.find((field) => field.type === 'single_select') ?? fields.find((field) => field.type === 'user');
  return choice ? { fieldId: choice.id } : { systemField: 'created_at', dateBucket: 'month' };
}

export interface CardDefaultsContext {
  schema: BuilderSchema;
  id: string;
  layout: AppCardLayout;
  /** The table to start from when it fits the kind (else the first table that does). */
  tableId?: number;
  /** A `buttons` card starts with one button opening this page. */
  pageId: string;
  /** The starting label of that button (in the builder's language — it is their content to edit). */
  buttonLabel: string;
}

/**
 * A new card of `kind` that the server will accept as is: bound to a table
 * that can host it, showing the first few fields, titled after its table.
 * Null when the Base has no table for it (see `catalogBlocker`).
 */
export function defaultCard(kind: AppCardKind, context: CardDefaultsContext): AppCard | null {
  const { schema, id, layout } = context;
  const base = { id, layout };
  if (kind === 'text') return { ...base, kind: 'text', markdown: '' };
  if (kind === 'buttons') {
    return {
      ...base,
      kind: 'buttons',
      buttons: [{ id: 'button-1', label: context.buttonLabel, type: 'open_page', pageId: context.pageId }],
    };
  }
  const tables = eligibleTables(kind, schema);
  const table = tables.find((entry) => entry.id === context.tableId) ?? tables[0];
  if (!table) return null;
  const fields = fieldsOf(schema, table.id);
  const titled = { ...base, title: table.name.slice(0, APP_LIMITS.nameLength) };
  const source: AppDataSource = { tableId: table.id };
  switch (kind) {
    case 'records':
      return {
        ...titled,
        kind,
        source,
        fieldIds: firstFieldIds(fields, 5),
        display: 'table',
        detail: { fieldIds: firstFieldIds(fields, 20) },
      };
    case 'kanban': {
      const lane = laneFields(fields)[0]!;
      return {
        ...titled,
        kind,
        source,
        groupFieldId: lane.id,
        fieldIds: firstFieldIds(fields, 3, [lane.id]),
        detail: { fieldIds: firstFieldIds(fields, 20) },
      };
    }
    case 'calendar':
      return {
        ...titled,
        kind,
        source,
        startFieldId: dateFields(fields)[0]!.id,
        fieldIds: firstFieldIds(fields, 2),
        detail: { fieldIds: firstFieldIds(fields, 20) },
      };
    case 'gallery': {
      const cover = attachmentFields(fields)[0];
      return {
        ...titled,
        kind,
        source,
        ...(cover ? { coverFieldId: cover.id } : {}),
        fieldIds: firstFieldIds(fields, 3),
        detail: { fieldIds: firstFieldIds(fields, 20) },
      };
    }
    case 'form':
      return {
        ...titled,
        kind,
        tableId: table.id,
        fieldIds: primaryFirst(writableFields(fields))
          .slice(0, 8)
          .map((field) => field.id),
      };
    case 'kpi':
      return { ...titled, kind, card: { kind: 'kpi', source, aggregate: { operation: 'count' } } };
    case 'chart':
      return {
        ...titled,
        kind,
        card: {
          kind: 'chart',
          source,
          aggregate: { operation: 'count', groupBy: defaultGroupBy(fields) },
          chart: { type: 'bar' },
        },
      };
    case 'pivot':
      return {
        ...titled,
        kind,
        card: { kind: 'pivot', source, aggregate: { operation: 'count', groupBy: defaultGroupBy(fields) } },
      };
    case 'custom':
      return {
        ...titled,
        kind,
        html: '<main id="rows"></main><script>greenhouse.query("rows").then(function(result){document.getElementById("rows").textContent=JSON.stringify(result,null,2);});</script>',
        bindings: [{ id: 'rows', kind: 'records', source, fieldIds: firstFieldIds(fields, 5) }],
      };
    // External sources join when their editor lands.

    case 'external':
      return null;
  }
}

/**
 * The same card on another table: field-bound settings start over (another
 * table's fields), the id, the layout and a title the builder wrote stay.
 */
export function retargetCard(card: AppCard, tableId: number, schema: BuilderSchema, pageId: string): AppCard | null {
  const next = defaultCard(card.kind, { schema, id: card.id, layout: card.layout, tableId, pageId, buttonLabel: '' });
  if (!next || cardTableId(next) !== tableId) return null;
  const previousTable = tableName(schema, cardTableId(card));
  const keepTitle = card.title !== undefined && card.title !== previousTable;
  if (keepTitle) return { ...next, title: card.title };
  return next;
}

// ─── Spec edits ───────────────────────────────────────────

/**
 * `value` with an optional list set — or left out when the list is empty: the
 * spec never stores an empty optional list (an empty `roles` list is the one
 * exception, and is written explicitly — it means nobody).
 */
export function withList<T extends object, K extends keyof T>(value: T, key: K, list: readonly unknown[]): T {
  const next = { ...value };
  if (list.length === 0) delete next[key];
  else next[key] = list as T[K];
  return next;
}

export function findPageIndex(spec: AppSpec, pageId: string): number {
  return spec.pages.findIndex((page) => page.id === pageId);
}

export function updatePage(spec: AppSpec, pageId: string, edit: (page: AppPage) => AppPage): AppSpec {
  return { ...spec, pages: spec.pages.map((page) => (page.id === pageId ? edit(page) : page)) };
}

export function updateCard(spec: AppSpec, pageId: string, cardId: string, edit: (card: AppCard) => AppCard): AppSpec {
  return updatePage(spec, pageId, (page) => ({
    ...page,
    cards: page.cards.map((card) => (card.id === cardId ? edit(card) : card)),
  }));
}

/** A new page with one empty text card (a page needs at least one card). */
export function addPage(spec: AppSpec, title: string): { spec: AppSpec; pageId: string } {
  const pageId = slugId(
    title,
    spec.pages.map((page) => page.id),
    'page',
    [APP_BUILDER_SEGMENT],
  );
  const page: AppPage = {
    id: pageId,
    title: title.trim().slice(0, APP_LIMITS.nameLength) || pageId,
    cards: [{ id: 'text-1', kind: 'text', layout: { x: 0, y: 0, ...CARD_SIZES.text }, markdown: '' }],
  };
  return { spec: { ...spec, pages: [...spec.pages, page] }, pageId };
}

/** Move a page to `toIndex` (clamped). Roles keep their page lists; only the order of tabs changes. */
export function movePage(spec: AppSpec, pageId: string, toIndex: number): AppSpec {
  const from = findPageIndex(spec, pageId);
  if (from === -1) return spec;
  const pages = [...spec.pages];
  const [page] = pages.splice(from, 1);
  pages.splice(Math.max(0, Math.min(toIndex, pages.length)), 0, page!);
  return { ...spec, pages };
}

export type PageDeletionBlocker =
  | { kind: 'lastPage' }
  /** The role sees only this page: deleting it would leave the role with nothing (and an invalid spec). */
  | { kind: 'onlyPageOfRole'; roleKey: string; roleName: string }
  /** A button elsewhere opens this page. */
  | { kind: 'openedBy'; pageId: string; pageTitle: string; buttonLabel: string };

export function pageDeletionBlockers(spec: AppSpec, pageId: string): PageDeletionBlocker[] {
  const blockers: PageDeletionBlocker[] = [];
  if (spec.pages.length <= 1) blockers.push({ kind: 'lastPage' });
  for (const role of spec.roles) {
    if (role.pages !== 'all' && role.pages.length === 1 && role.pages[0] === pageId) {
      blockers.push({ kind: 'onlyPageOfRole', roleKey: role.key, roleName: role.name });
    }
  }
  for (const page of spec.pages) {
    if (page.id === pageId) continue;
    for (const card of page.cards) {
      if (card.kind !== 'buttons') continue;
      for (const button of card.buttons) {
        if (button.type === 'open_page' && button.pageId === pageId) {
          blockers.push({ kind: 'openedBy', pageId: page.id, pageTitle: page.title, buttonLabel: button.label });
        }
      }
    }
  }
  return blockers;
}

/** Delete a page (callers check `pageDeletionBlockers` first): roles stop listing it, home moves to the first page. */
export function deletePage(spec: AppSpec, pageId: string): AppSpec {
  const pages = spec.pages.filter((page) => page.id !== pageId);
  const roles = spec.roles.map((role) =>
    role.pages === 'all' ? role : { ...role, pages: role.pages.filter((id) => id !== pageId) },
  );
  const next: AppSpec = { ...spec, pages, roles };
  if (spec.home === pageId) delete next.home;
  return next;
}

export function setHome(spec: AppSpec, pageId: string | undefined): AppSpec {
  const next = { ...spec };
  if (pageId === undefined || pageId === spec.pages[0]?.id) delete next.home;
  else next.home = pageId;
  return next;
}

export function addCard(spec: AppSpec, pageId: string, card: AppCard): AppSpec {
  return updatePage(spec, pageId, (page) => ({ ...page, cards: [...page.cards, card] }));
}

/** The id a new card of `kind` gets on a page. */
export function newCardId(page: AppPage, kind: AppCardKind): string {
  return slugId(
    `${kind}-${page.cards.filter((card) => card.kind === kind).length + 1}`,
    page.cards.map((card) => card.id),
    kind,
  );
}

/** Remove a card (a page keeps at least one: callers disable deleting the last). */
export function removeCard(spec: AppSpec, pageId: string, cardId: string): AppSpec {
  return updatePage(spec, pageId, (page) =>
    page.cards.length <= 1 ? page : { ...page, cards: page.cards.filter((card) => card.id !== cardId) },
  );
}

/** Apply a dragged / resized arrangement from the canvas. */
export function setCardLayouts(
  spec: AppSpec,
  pageId: string,
  layouts: ReadonlyArray<{ id: string } & AppCardLayout>,
): AppSpec {
  const byId = new Map(layouts.map((entry) => [entry.id, entry]));
  return updatePage(spec, pageId, (page) => ({
    ...page,
    cards: page.cards.map((card) => {
      const next = byId.get(card.id);
      return next ? { ...card, layout: { x: next.x, y: next.y, w: next.w, h: next.h } } : card;
    }),
  }));
}

// ─── Roles ────────────────────────────────────────────────

export function addRole(spec: AppSpec, name: string): { spec: AppSpec; roleKey: string } {
  const roleKey = slugId(
    name,
    spec.roles.map((role) => role.key),
    'role',
  );
  const role: AppRole = {
    key: roleKey,
    name: name.trim().slice(0, APP_LIMITS.nameLength) || roleKey,
    pages: 'all',
    tables: [],
  };
  return { spec: { ...spec, roles: [...spec.roles, role] }, roleKey };
}

export function updateRole(spec: AppSpec, roleKey: string, edit: (role: AppRole) => AppRole): AppSpec {
  return { ...spec, roles: spec.roles.map((role) => (role.key === roleKey ? edit(role) : role)) };
}

/** Every `roles` list in the spec (actions, creates, forms, buttons, kanban moves), with a writer. */
function mapRoleLists(spec: AppSpec, edit: (roles: string[]) => string[]): AppSpec {
  const fixActions = (actions: AppRecordAction[] | undefined) =>
    actions?.map((action) => (action.roles ? { ...action, roles: edit(action.roles) } : action));
  const fixButtons = (buttons: AppButton[]) =>
    buttons.map((button) => (button.roles ? { ...button, roles: edit(button.roles) } : button));
  return {
    ...spec,
    pages: spec.pages.map((page) => ({
      ...page,
      cards: page.cards.map((card): AppCard => {
        if (card.kind === 'form') return card.roles ? { ...card, roles: edit(card.roles) } : card;
        if (card.kind === 'buttons') return { ...card, buttons: fixButtons(card.buttons) };
        if (!isRecordsLike(card)) return card;
        const next = { ...card } as RecordsLikeCard;
        if (card.actions) next.actions = fixActions(card.actions);
        if (card.detail?.actions) next.detail = { ...card.detail, actions: fixActions(card.detail.actions) };
        if (card.kind === 'records' && card.create?.roles) {
          (next as Extract<AppCard, { kind: 'records' }>).create = { ...card.create, roles: edit(card.create.roles) };
        }
        if (card.kind === 'kanban' && card.move?.roles) {
          (next as Extract<AppCard, { kind: 'kanban' }>).move = { ...card.move, roles: edit(card.move.roles) };
        }
        return next;
      }),
    })),
  };
}

/** How many `roles` lists name this role (shown before deleting it). */
export function roleListMentions(spec: AppSpec, roleKey: string): number {
  let count = 0;
  mapRoleLists(spec, (roles) => {
    if (roles.includes(roleKey)) count += 1;
    return roles;
  });
  return count;
}

/**
 * Delete a role (callers keep at least one). Lists that named it drop it — a
 * list left empty stays empty (nobody), never "everyone": deleting a role must
 * not open an action to roles it was kept from.
 */
export function deleteRole(spec: AppSpec, roleKey: string): AppSpec {
  const next = mapRoleLists(spec, (roles) => roles.filter((key) => key !== roleKey));
  return { ...next, roles: next.roles.filter((role) => role.key !== roleKey) };
}

// ─── Page filters ─────────────────────────────────────────

export const PAGE_REF_PREFIX = '$page.';

export function pageRef(filterId: string): string {
  return `${PAGE_REF_PREFIX}${filterId}`;
}

export function isPageRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PAGE_REF_PREFIX);
}

function withoutRefTo(group: TableFilterGroup | undefined, ref: string): TableFilterGroup | undefined {
  if (!group) return group;
  const clauses = group.clauses.filter((clause) => clause.value !== ref);
  return clauses.length > 0 ? { ...group, clauses } : undefined;
}

function queryWithoutRef(query: AppDataSource['query'], ref: string): AppDataSource['query'] {
  if (!query) return query;
  const out = { ...query };
  const where = withoutRefTo(query.where, ref);
  if (where) out.where = where;
  else delete out.where;
  const filters = query.filters?.map((group) => withoutRefTo(group, ref)).filter((group) => group !== undefined);
  if (filters && filters.length > 0) out.filters = filters;
  else delete out.filters;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Remove a page filter and every `$page.<id>` condition that read it (the validator refuses dangling refs). */
export function removePageFilter(spec: AppSpec, pageId: string, filterId: string): AppSpec {
  const ref = pageRef(filterId);
  return updatePage(spec, pageId, (page) => {
    const filters = (page.filters ?? []).filter((control) => control.id !== filterId);
    const next: AppPage = {
      ...page,
      cards: page.cards.map((card): AppCard => {
        if (isRecordsLike(card)) {
          const query = queryWithoutRef(card.source.query, ref);
          const source: AppDataSource = { tableId: card.source.tableId, ...(query ? { query } : {}) };
          return { ...card, source };
        }
        if (isEmbedded(card) && card.card.source) {
          const query = queryWithoutRef(card.card.source.query, ref);
          return {
            ...card,
            card: { ...card.card, source: { tableId: card.card.source.tableId, ...(query ? { query } : {}) } },
          };
        }
        return card;
      }),
    };
    if (filters.length > 0) next.filters = filters;
    else delete next.filters;
    return next;
  });
}

// ─── Actions and buttons ──────────────────────────────────

export function newActionId(card: AppCard): string {
  const taken = cardActionIds(card);
  return slugId(`action-${taken.length + 1}`, taken, 'action');
}

export function newButtonId(buttons: readonly AppButton[]): string {
  const taken = buttons.map((button) => button.id);
  return slugId(`button-${taken.length + 1}`, taken, 'button');
}

/** The roles an action (or button, form, create, move) applies to: its list, else every role that sees the page. */
export function appliesTo(spec: AppSpec, pageId: string, roles: readonly string[] | undefined): AppRole[] {
  if (roles) return spec.roles.filter((role) => roles.includes(role.key));
  return spec.roles.filter((role) => role.pages === 'all' || role.pages.includes(pageId));
}
