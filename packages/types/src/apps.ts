/**
 * Apps (应用) — user-built applications on top of a Tables Base.
 *
 * An app is a versioned JSON specification: pages of cards drawn from a fixed
 * catalog, roles with the same access-rule shape as a Base's custom roles, and
 * declarative actions. The server gateway evaluates every card for the viewer's
 * role live (store the question, not the answer); clients only render.
 *
 * Spec: docs/specs/20261011-tables-apps.md. Vendored verbatim into the mobile
 * app (with ./tables and ./table-access), so no runtime dependencies.
 */

import type {
  TableCardSpec,
  TableFieldValueEntry,
  TableFilterControl,
  TableFilterGroup,
  TableFilterValue,
  TableQuery,
  TableFormUploadView,
  TableSystemField,
} from './tables.js';
import type { TableAccessRule } from './table-access.js';
import type { TableCardResult } from './table-cards.js';

// ─── Limits ───────────────────────────────────────────────

export const APP_LIMITS = Object.freeze({
  pages: 20,
  cardsPerPage: 30,
  roles: 10,
  actionsPerCard: 8,
  buttonsPerCard: 8,
  filtersPerPage: 6,
  nameLength: 60,
  idLength: 40,
  markdownLength: 20_000,
  specBytes: 512 * 1024,
});

/** Page / card / role / action ids: short slugs, unique within their scope. */
export const APP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The address segment of an app's builder (`#/apps/:id/edit`) — so no page may use it as its id. */
export const APP_BUILDER_SEGMENT = 'edit';

/** Icons an app or a page may use — a fixed list so every client can draw them. */
export const APP_ICONS = [
  'app',
  'inbox',
  'check',
  'clipboard',
  'cart',
  'users',
  'briefcase',
  'calendar',
  'chart',
  'table',
  'kanban',
  'ticket',
  'wrench',
  'book',
  'star',
  'flag',
  'home',
  'settings',
] as const;
export type AppIconName = (typeof APP_ICONS)[number];

/** Accent colours map onto design tokens on every client (never raw colours). */
export const APP_ACCENTS = ['brand', 'blue', 'teal', 'amber', 'rose', 'violet', 'slate'] as const;
export type AppAccent = (typeof APP_ACCENTS)[number];

// ─── Specification ────────────────────────────────────────

export interface AppSpec {
  version: 1;
  pages: AppPage[];
  roles: AppRole[];
  /** Page shown first; default the first page the role may see. */
  home?: string;
  nav?: { layout: 'tabs' | 'sidebar' };
}

export interface AppPage {
  id: string;
  title: string;
  icon?: AppIconName;
  /** Viewer-controlled filters; cards reference them as `$page.<filterId>` or via the control's targets. */
  filters?: TableFilterControl[];
  cards: AppCard[];
}

export interface AppRole {
  key: string;
  name: string;
  pages: 'all' | string[];
  /** Same shape as a Base custom role's per-table rule. A table with no rule is invisible. */
  tables: TableAccessRule[];
  canComment?: boolean;
}

export interface AppCardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a records-like card reads from. `query` may use system fields, `$me`, date tokens and `$page.<filterId>`. */
export interface AppDataSource {
  tableId: number;
  query?: Omit<TableQuery, 'cursor' | 'limit'>;
}

export interface AppRecordDetail {
  fieldIds: number[];
  systemFields?: TableSystemField[];
  /** ∩ the role's editable fields and edit rows. */
  editableFieldIds?: number[];
  actions?: AppRecordAction[];
  comments?: boolean;
}

export type AppRecordActionEffect =
  | {
      type: 'set_fields';
      /** Values may use `$me`, `$now`, `$today`. */
      values: TableFieldValueEntry[];
      /** Collected in a dialog and written in the same write as `values`. */
      inputFieldIds?: number[];
      requiredInputFieldIds?: number[];
    }
  /** Runs the rule as its execution user, asynchronously. */
  | { type: 'run_automation'; ruleId: number }
  | { type: 'delete' };

export interface AppRecordAction {
  id: string;
  label: string;
  /** Roles that may use it; default every role that can see the page. */
  roles?: string[];
  /** Precondition, evaluated server-side inside the write transaction against the current revision. */
  when?: TableFilterGroup;
  /** Confirmation text shown before running. */
  confirm?: string;
  do: AppRecordActionEffect;
}

export interface AppCreateSpec {
  fieldIds: number[];
  defaults?: TableFieldValueEntry[];
  roles?: string[];
}

export type AppButton = { id: string; label: string; roles?: string[] } & (
  | { type: 'open_page'; pageId: string }
  | { type: 'open_url'; url: string }
  | { type: 'create_record'; tableId: number; fieldIds: number[]; defaults?: TableFieldValueEntry[] }
);

interface AppCardBase {
  id: string;
  title?: string;
  layout: AppCardLayout;
}

export type AppCard = AppCardBase &
  (
    | {
        kind: 'records';
        source: AppDataSource;
        fieldIds: number[];
        systemFields?: TableSystemField[];
        display?: 'table' | 'list';
        detail?: AppRecordDetail;
        create?: AppCreateSpec;
        /** Row / card-face actions. */
        actions?: AppRecordAction[];
      }
    | {
        kind: 'kanban';
        source: AppDataSource;
        groupFieldId: number;
        fieldIds: number[];
        coverFieldId?: number;
        detail?: AppRecordDetail;
        actions?: AppRecordAction[];
        /** Dragging between lanes; off unless set. */
        move?: { roles?: string[]; when?: TableFilterGroup };
      }
    | {
        kind: 'calendar';
        source: AppDataSource;
        startFieldId: number;
        endFieldId?: number;
        fieldIds: number[];
        detail?: AppRecordDetail;
        actions?: AppRecordAction[];
      }
    | {
        kind: 'gallery';
        source: AppDataSource;
        coverFieldId?: number;
        fieldIds: number[];
        detail?: AppRecordDetail;
        actions?: AppRecordAction[];
      }
    | {
        kind: 'form';
        tableId: number;
        fieldIds: number[];
        defaults?: TableFieldValueEntry[];
        submitLabel?: string;
        successMessage?: string;
        roles?: string[];
      }
    | { kind: 'kpi' | 'chart' | 'pivot'; card: TableCardSpec }
    | { kind: 'text'; markdown: string }
    | { kind: 'buttons'; buttons: AppButton[] }
    /**
     * A sandboxed custom component (Phase 2, docs/specs/20261011-tables-apps-advanced.md §1, D1).
     * The platform assembles the document around `html` (`@greenhouse/types/app-sandbox`);
     * the component reads its `bindings` and runs its declared `actions` / `create`
     * over the bridge — every action confirmed by the host, never `delete`.
     */
    | {
        kind: 'custom';
        /** The component's body and scripts (≤ `APP_SANDBOX_LIMITS.htmlBytes` UTF-8 bytes). */
        html: string;
        /** What the component may read: records or an aggregate of this Base's tables, evaluated for the viewer's role. */
        bindings: AppCustomBinding[];
        /** Declared record actions, each on the records of one `records` binding (never `delete`). */
        actions?: AppCustomAction[];
        /** Creating a record in the table of one `records` binding. */
        create?: AppCustomCreate;
        /** Starting height in CSS pixels before the component reports its size (hosts without a grid row). */
        height?: number;
      }
    /**
     * Data from outside the Base (Phase 2, §5, D4, D11): a read tool or a
     * connector tool, evaluated as the viewer with their own access (app roles do
     * not apply), drawn as plain data — a KPI, a chart or a table, as the source's
     * `map` says (`externalDisplay`).
     */
    | {
        kind: 'external';
        source: AppExternalSource;
        /** Chart maps: how to draw it (the Tables chart options). */
        chart?: NonNullable<TableCardSpec['chart']>;
      }
  );

export type AppCardKind = AppCard['kind'];

export const APP_CARD_KINDS = [
  'records',
  'kanban',
  'calendar',
  'gallery',
  'form',
  'kpi',
  'chart',
  'pivot',
  'text',
  'buttons',
  'custom',
  'external',
] as const satisfies readonly AppCardKind[];

/**
 * Card kinds the mobile app draws natively. Requests from mobile declare this
 * list; an older build meeting a newer kind shows "open on the web" instead of
 * crashing. An explicit list (not `APP_CARD_KINDS`): a kind joins it when the
 * phone draws it (Phase 2 slice M adds `custom` / `external`).
 */
export const MOBILE_APP_CARDS: readonly AppCardKind[] = [
  'records',
  'kanban',
  'calendar',
  'gallery',
  'form',
  'kpi',
  'chart',
  'pivot',
  'text',
  'buttons',
];

// ─── Custom cards (Phase 2 §1) ─────────────────────────────

/**
 * One thing a custom component may read, by id (`tools/call` name
 * `query.<id>`): a page of records (`fieldIds` are its columns) or an
 * aggregate (`aggregateBindingCard`), from a table of this Base — never a tool
 * or connector source. Evaluated exactly like a records / aggregate card for
 * the viewer's role; `source.query` may use `$page.<filterId>`.
 */
export interface AppCustomBinding {
  id: string;
  source: AppDataSource;
  kind: 'records' | 'aggregate';
  /** `records`: the fields delivered (∩ the role's readable fields). Required for records, absent for aggregates. */
  fieldIds?: number[];
  /** `aggregate`: no `groupBy` = one number (a KPI); with `groupBy` = rows (pivot-shaped, `series` allowed). */
  aggregate?: NonNullable<TableCardSpec['aggregate']>;
}

/** A custom card's record action: a Phase 1 action (never `delete`) on the records of `bindingId` (a `records` binding). */
export type AppCustomAction = AppRecordAction & { bindingId: string };

/** A custom card's create: in the table of `bindingId` (a `records` binding). */
export type AppCustomCreate = AppCreateSpec & { bindingId: string };

/**
 * The `TableCardSpec` an aggregate binding is evaluated as — one shape for the
 * validator and the gateway: no `groupBy` → `kpi`, else `pivot` (rows of
 * group × optional series).
 */
export function aggregateBindingCard(binding: AppCustomBinding): TableCardSpec {
  const aggregate = binding.aggregate ?? { operation: 'count' };
  return {
    kind: aggregate.groupBy ? 'pivot' : 'kpi',
    source: binding.source,
    aggregate,
  };
}

/** The binding a custom card's action or create writes through. */
export function customBinding(
  card: Extract<AppCard, { kind: 'custom' }>,
  bindingId: string,
): AppCustomBinding | undefined {
  return card.bindings.find((binding) => binding.id === bindingId);
}

// ─── External data sources (Phase 2 §5) ────────────────────

/** RFC 6901 JSON Pointer into a source's JSON result: `''` = the whole value, `/items/0/name`. */
export type AppJsonPointer = string;

export const APP_SOURCE_COLUMN_TYPES = ['text', 'number', 'date', 'datetime', 'boolean', 'url'] as const;
export type AppSourceColumnType = (typeof APP_SOURCE_COLUMN_TYPES)[number];

/** One column of a table map: `path` is read from each row element. */
export interface AppSourceColumn {
  /** Unique within the map (`APP_ID_PATTERN`); the row's cell key. */
  key: string;
  label: string;
  path: AppJsonPointer;
  /** How the cell is coerced and drawn; default `text`. */
  type?: AppSourceColumnType;
}

/**
 * How a source's JSON result becomes card data — declarative, no code. The
 * result is a tool's JSON answer, or a connector's `structuredContent` (else its
 * text parsed as JSON). Its `kind` is the card's display:
 * - `kpi`: the number at `value` (a number or a numeric string; an array counts its items);
 * - `chart`: each element of the array at `rows` is a point — `group` (label),
 *   `value` (number), optional `series` (paths relative to the element);
 * - `table`: each element of the array at `rows` is a row; `columns` pick its cells.
 */
export type AppSourceMap =
  | { kind: 'kpi'; value: AppJsonPointer }
  | { kind: 'chart'; rows: AppJsonPointer; group: AppJsonPointer; value: AppJsonPointer; series?: AppJsonPointer }
  | { kind: 'table'; rows: AppJsonPointer; columns: AppSourceColumn[] };

export type AppExternalDisplay = AppSourceMap['kind'];

/** A read tool of the viewer's own tool set (the workbench's bindable read tools). */
export interface AppToolSource {
  kind: 'tool';
  toolId: string;
  input: Record<string, unknown>;
  map: AppSourceMap;
}

/** A connector tool (`mcp_call`'s `server` slug + tool name) the directory reports read-only, called with the viewer's own connection. */
export interface AppConnectorSource {
  kind: 'connector';
  server: string;
  tool: string;
  input: Record<string, unknown>;
  map: AppSourceMap;
}

export type AppExternalSource = AppToolSource | AppConnectorSource;

export const APP_SOURCE_LIMITS = Object.freeze({
  /** Rows a table / chart map keeps (the rest is dropped, `truncated: true`). */
  rows: 200,
  columns: 20,
  /** `JSON.stringify(input)` bytes. */
  inputBytes: 8 * 1024,
  pointerLength: 200,
  /** The source's raw result is refused above this. */
  resultBytes: 512 * 1024,
  /** One evaluation's wall clock. */
  timeoutMs: 15_000,
  /** Characters a text cell keeps. */
  cellText: 2_000,
});

/** What a card of this source shows. */
export function externalDisplay(source: AppExternalSource): AppExternalDisplay {
  return source.map.kind;
}

/** Whether `pointer` is an RFC 6901 JSON Pointer (`''` or `/`-prefixed, `~` only as `~0` / `~1`). */
export function isJsonPointer(pointer: unknown): pointer is AppJsonPointer {
  return (
    typeof pointer === 'string' &&
    pointer.length <= APP_SOURCE_LIMITS.pointerLength &&
    (pointer === '' || (pointer.startsWith('/') && !/~[^01]|~$/.test(pointer)))
  );
}

/** The value `pointer` names in `document`, or undefined (array indexes are decimal, `-` names nothing). */
export function readJsonPointer(document: unknown, pointer: AppJsonPointer): unknown {
  if (!isJsonPointer(pointer)) return undefined;
  if (pointer === '') return document;
  let current: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

// ─── Pure helpers ─────────────────────────────────────────

export function findPage(spec: AppSpec, pageId: string): AppPage | undefined {
  return spec.pages.find((page) => page.id === pageId);
}

export function findCard(spec: AppSpec, pageId: string, cardId: string): AppCard | undefined {
  return findPage(spec, pageId)?.cards.find((card) => card.id === cardId);
}

export function findRole(spec: AppSpec, roleKey: string): AppRole | undefined {
  return spec.roles.find((role) => role.key === roleKey);
}

/** Pages a role may open, in spec order. */
export function pagesForRole(spec: AppSpec, role: AppRole): AppPage[] {
  if (role.pages === 'all') return spec.pages;
  const allowed = new Set(role.pages);
  return spec.pages.filter((page) => allowed.has(page.id));
}

/** Roles that can see a page. */
export function rolesForPage(spec: AppSpec, pageId: string): AppRole[] {
  return spec.roles.filter((role) => role.pages === 'all' || role.pages.includes(pageId));
}

/** Whether `role` may use `action` on a card of `page` (roles list, page visibility). Server re-checks data rules. */
export function actionAllowedForRole(
  spec: AppSpec,
  pageId: string,
  action: Pick<AppRecordAction, 'roles'>,
  roleKey: string,
): boolean {
  const role = findRole(spec, roleKey);
  if (!role) return false;
  if (!pagesForRole(spec, role).some((page) => page.id === pageId)) return false;
  return !action.roles || action.roles.includes(roleKey);
}

/** The tables, fields, rules and roles a spec depends on — used to refuse destructive schema changes (apps spec D6). */
export interface AppSpecDependencies {
  tableIds: number[];
  fieldIds: number[];
  ruleIds: number[];
  roleKeys: string[];
}

function collectFilterFields(group: TableFilterGroup | undefined, into: Set<number>): void {
  for (const clause of group?.clauses ?? []) if (clause.fieldId !== undefined) into.add(clause.fieldId);
}

function collectQueryFields(query: AppDataSource['query'] | undefined, into: Set<number>): void {
  if (!query) return;
  collectFilterFields(query.where, into);
  for (const group of query.filters ?? []) collectFilterFields(group, into);
  for (const sort of query.sort ?? []) if (sort.fieldId !== undefined) into.add(sort.fieldId);
  if (query.groupBy?.fieldId !== undefined) into.add(query.groupBy.fieldId);
}

function collectActions(actions: AppRecordAction[] | undefined, fields: Set<number>, rules: Set<number>): void {
  for (const action of actions ?? []) {
    collectFilterFields(action.when, fields);
    if (action.do.type === 'set_fields') {
      for (const entry of action.do.values) fields.add(entry.fieldId);
      for (const id of action.do.inputFieldIds ?? []) fields.add(id);
    }
    if (action.do.type === 'run_automation') rules.add(action.do.ruleId);
  }
}

export function appSpecDependencies(spec: AppSpec): AppSpecDependencies {
  const tables = new Set<number>();
  const fields = new Set<number>();
  const rules = new Set<number>();
  for (const page of spec.pages) {
    for (const control of page.filters ?? []) {
      for (const target of control.targets) {
        tables.add(target.tableId);
        if (target.fieldId !== undefined) fields.add(target.fieldId);
      }
    }
    for (const card of page.cards) {
      switch (card.kind) {
        case 'records':
        case 'kanban':
        case 'calendar':
        case 'gallery': {
          tables.add(card.source.tableId);
          collectQueryFields(card.source.query, fields);
          for (const id of card.fieldIds) fields.add(id);
          if (card.kind === 'kanban') fields.add(card.groupFieldId);
          if (card.kind === 'calendar') {
            fields.add(card.startFieldId);
            if (card.endFieldId !== undefined) fields.add(card.endFieldId);
          }
          if ((card.kind === 'kanban' || card.kind === 'gallery') && card.coverFieldId !== undefined) {
            fields.add(card.coverFieldId);
          }
          for (const id of card.detail?.fieldIds ?? []) fields.add(id);
          for (const id of card.detail?.editableFieldIds ?? []) fields.add(id);
          collectActions(card.detail?.actions, fields, rules);
          collectActions(card.actions, fields, rules);
          if (card.kind === 'records') for (const id of card.create?.fieldIds ?? []) fields.add(id);
          break;
        }
        case 'form':
          tables.add(card.tableId);
          for (const id of card.fieldIds) fields.add(id);
          for (const entry of card.defaults ?? []) fields.add(entry.fieldId);
          break;
        case 'kpi':
        case 'chart':
        case 'pivot': {
          const source = card.card.source;
          if (source) {
            tables.add(source.tableId);
            collectQueryFields(source.query, fields);
          }
          const aggregate = card.card.aggregate;
          if (aggregate?.valueFieldId !== undefined) fields.add(aggregate.valueFieldId);
          if (aggregate?.groupBy?.fieldId !== undefined) fields.add(aggregate.groupBy.fieldId);
          if (aggregate?.series?.fieldId !== undefined) fields.add(aggregate.series.fieldId);
          break;
        }
        case 'buttons':
          for (const button of card.buttons) {
            if (button.type === 'create_record') {
              tables.add(button.tableId);
              for (const id of button.fieldIds) fields.add(id);
            }
          }
          break;
        case 'custom':
          for (const binding of card.bindings) {
            tables.add(binding.source.tableId);
            collectQueryFields(binding.source.query, fields);
            for (const id of binding.fieldIds ?? []) fields.add(id);
            const aggregate = binding.aggregate;
            if (aggregate?.valueFieldId !== undefined) fields.add(aggregate.valueFieldId);
            if (aggregate?.groupBy?.fieldId !== undefined) fields.add(aggregate.groupBy.fieldId);
            if (aggregate?.series?.fieldId !== undefined) fields.add(aggregate.series.fieldId);
          }
          collectActions(card.actions, fields, rules);
          for (const id of card.create?.fieldIds ?? []) fields.add(id);
          for (const entry of card.create?.defaults ?? []) fields.add(entry.fieldId);
          break;
        case 'text':
        case 'external':
          break;
      }
    }
  }
  for (const role of spec.roles) {
    for (const rule of role.tables) {
      tables.add(rule.tableId);
      for (const entry of rule.fields) fields.add(entry.fieldId);
    }
  }
  return {
    tableIds: [...tables].sort((a, b) => a - b),
    fieldIds: [...fields].sort((a, b) => a - b),
    ruleIds: [...rules].sort((a, b) => a - b),
    roleKeys: spec.roles.map((role) => role.key),
  };
}

// ─── Wire views ───────────────────────────────────────────

export type AppStatus = 'draft' | 'published' | 'archived';
export type AppAudiencePrincipal =
  | { type: 'user'; userId: string }
  | { type: 'group'; groupId: number }
  | { type: 'team' };

export interface AppAudienceEntry {
  principal: AppAudiencePrincipal;
  roleKey: string;
}

export interface AppSummary {
  id: number;
  baseId: number;
  name: string;
  description: string | null;
  icon: AppIconName;
  accent: AppAccent;
  ownerId: string;
  status: AppStatus;
  publishedVersion: number | null;
  featured: boolean;
  updatedAt: string;
  /** The caller's relation to the app. */
  canManage: boolean;
  canPublish: boolean;
  pinned: boolean;
}

/** One card or action the runtime revalidation found broken against the current schema. */
export interface AppIssue {
  pageId: string;
  cardId?: string;
  actionId?: string;
  /** A page filter control that no longer works (added in F1; additive). */
  filterId?: string;
  message: string;
}

/** What a viewer receives: the published spec trimmed to their role, plus field metadata to render it. */
export interface AppRuntimeView {
  app: AppSummary;
  /** Pins a host confirmation to this definition; old servers may omit it. */
  specToken?: string;
  /** The published version shown; 0 for a manager's draft preview (`draft: true`). */
  version: number;
  /** Set when a manager previews the draft instead of the published version (added in F1; additive). */
  draft?: boolean;
  role: { key: string; name: string } | { key: '__manager__'; name: string };
  spec: AppSpec;
  /** Fields referenced by the visible cards and readable by the role, keyed by table. */
  tables: Array<{
    id: number;
    name: string;
    /** The role may create records here (its rule's `create`); absent on old servers = unknown, the write still checks. */
    canCreate?: boolean;
    fields: Array<{
      id: number;
      name: string;
      type: string;
      isPrimary: boolean;
      config: unknown;
      editable: boolean;
      /** Required when the role creates a record (a form, a create dialog); absent = not known, the write still checks (slice R; additive). */
      required?: boolean;
    }>;
  }>;
  issues: AppIssue[];
}

export interface AppCardQueryInput {
  pageId: string;
  cardId: string;
  /** `null` = the viewer cleared that filter (its default no longer applies), as on dashboards. */
  filterValues?: Record<string, TableFilterValue | null>;
  timezone?: string;
  cursor?: string;
  search?: string;
  /** Managers only: evaluate as this role. */
  previewRole?: string;
  /**
   * Managers only: evaluate the draft instead of the published version (also the
   * default before the first publish). Added by the gateway (slice G; additive).
   */
  draft?: boolean;
  /**
   * Calendar cards: only records whose start date falls in `from`…`to`
   * (YYYY-MM-DD, inclusive, the viewer's `timezone`). Added by the gateway (slice G; additive).
   */
  range?: { from: string; to: string };
  /**
   * Custom cards: the binding to evaluate (`tools/call` `query.<bindingId>`),
   * answered like a records card (records bindings) or a KPI / pivot card
   * (aggregate bindings). Phase 2; additive.
   */
  bindingId?: string;
}

export interface AppActionInput {
  pageId: string;
  cardId: string;
  actionId: string;
  recordId?: number;
  revision?: number;
  /** Input field values for set_fields actions, create values for create actions. */
  values?: TableFieldValueEntry[];
  requestId: string;
  /** Refuse if the definition changed since the host displayed its confirmation. */
  expectedSpecToken?: string;
  /** `$create` from a `create_record` button. */
  buttonId?: string;
  /** Managers only: act as this role (writes still run as the manager). */
  previewRole?: string;
  /** Managers only: act through the draft (slice G; additive). */
  draft?: boolean;
  /** The viewer's IANA zone: `$today` / `$now` in values (default UTC; slice G; additive). */
  timezone?: string;
}

// ─── Management wire views (F1; additive) ─────────────────

/**
 * A spec problem the server found, with where it is. Saving a draft reports
 * these without refusing (a draft may be mid-edit); publishing refuses while
 * any remain.
 */
export interface AppSpecError {
  /** `pages[0].cards[2].actions[1].do.values[0]` style. */
  path: string;
  message: string;
  pageId?: string;
  cardId?: string;
  actionId?: string;
  filterId?: string;
  roleKey?: string;
  /** A custom card's binding (Phase 2; additive). */
  bindingId?: string;
}

/** `GET /api/apps`: what the caller manages, what is shared with them, what is recommended to them. */
export interface AppListView {
  managed: AppSummary[];
  shared: AppSummary[];
  featured: AppSummary[];
}

/** The builder's draft: spec, revision for CAS, and the problems against today's schema. */
export interface AppDraftView {
  app: AppSummary;
  spec: AppSpec;
  draftRevision: number;
  errors: AppSpecError[];
}

export interface AppVersionSummary {
  version: number;
  notes: string | null;
  publishedBy: { id: string; name: string };
  publishedAt: string;
  /** The draft revision it was published from. */
  draftRevision: number;
  specHash: string;
  /** Versions with custom cards: the super's review of exactly this `specHash` (D10). Phase 2; additive. */
  customReview?: AppCustomReview;
}

/**
 * A super's review of a version's custom code (D10), stored on the version
 * (`table_app_versions.custom_review`). `hash` is the version's `specHash` it
 * was given for — a different spec is a different review.
 */
export interface AppCustomReview {
  status: AppCustomReviewStatus;
  hash: string;
  reviewedBy?: { id: string; name: string };
  reviewedAt?: string;
  note?: string;
}

export type AppCustomReviewStatus = 'pending' | 'approved' | 'rejected';

/** One audience entry with what the owner's editor shows next to it. */
export interface AppAudienceEntryView extends AppAudienceEntry {
  /** Person nickname, group name, or "everyone". */
  name: string;
  /** Groups: who controls membership (sharing with a group delegates "who gets in" to them). */
  managedBy?: { id: string; name: string };
  /** The role key is not in the live version (or the app is unpublished): the entry grants nothing today. */
  dangling?: boolean;
}

export interface AppAudiencesView {
  entries: AppAudienceEntryView[];
  audiencesRevision: number;
  /** The roles of the live version (else the draft) — what an entry may point at. */
  roles: Array<{ key: string; name: string }>;
}

// ─── Gateway wire contract (integration, before the Phase 1 wave; additive) ──
//
// What `/api/apps/:id/{cards/query,records/get,actions,activity,comments,options,
// uploads,usage}` and `/api/apps/templates` answer. The web runtime, the iOS
// runtime and the gateway all build against these; nothing here is a runtime value
// except the reserved action ids.

/**
 * Writes that are not a declared `AppRecordAction` go through `/actions` too,
 * under these reserved ids (`APP_ID_PATTERN` cannot produce a `$`, so they never
 * collide with a spec id):
 * - `$submit` — a `form` card's submit (`values` = the form's fields);
 * - `$create` — a records card's `create` spec, or a `create_record` button
 *   (`buttonId` names the button; `values` = its fields);
 * - `$move`   — a kanban card's lane change (`values` = the group field only);
 * - `$edit`   — the record drawer's inline edit (`values` ⊆ detail editable fields).
 */
export const APP_BUILTIN_ACTIONS = Object.freeze({
  submit: '$submit',
  create: '$create',
  move: '$move',
  edit: '$edit',
} as const);
export type AppBuiltinActionId = (typeof APP_BUILTIN_ACTIONS)[keyof typeof APP_BUILTIN_ACTIONS];

/** A record as an app card or the drawer delivers it: only role-readable ∩ card fields (computed values merged in). */
export interface AppRecordRow {
  id: number;
  revision: number;
  /** Keyed by field id; fields the viewer may not read are absent, never null-filled. */
  values: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Who wrote it last — the `updated_by` system column (slice R; additive, absent from older gateways). */
  updatedBy?: string | null;
  /** Declared card-face actions this viewer may run on this record now (`when` checked at read time; the write re-checks). */
  actionIds: string[];
}

/** Labels for what the rows point at — app viewers cannot call `/api/tables`, so the gateway resolves them. */
export interface AppRecordRefs {
  /** People named by user fields and `created_by`. */
  users: Record<string, { nickname: string; avatar?: string | null }>;
  /** Relation targets keyed `<tableId>:<recordId>`: the label, or `null` when the row is outside the role's read scope. */
  records: Record<string, string | null>;
  /** Attachments keyed by file id (download via `GET /api/apps/:id/files/:fileId`). */
  files: Record<string, { name: string; size: number; mimeType: string | null }>;
}

/**
 * `POST /api/apps/:id/cards/query` (input `AppCardQueryInput`). Records-like
 * cards page their records; aggregate cards answer like a dashboard card;
 * `unavailable` = the runtime revalidation found the card broken (D6).
 */
export type AppCardQueryResult =
  | { kind: 'records'; records: AppRecordRow[]; total: number; nextCursor: string | null; refs: AppRecordRefs }
  | Exclude<TableCardResult, { kind: 'records' }>
  | { kind: 'unavailable'; message: string }
  /** External cards with a `table` map (Phase 2; additive): plain data, never HTML. */
  | AppSourceTableResult
  /** External connector cards: the viewer has to connect first (the client draws a connect card). */
  | { kind: 'needs_connection'; connection: AppSourceNeedsConnection }
  /** External cards: the source failed this time (try again later), or its answer did not fit the map. */
  | { kind: 'source_error'; reason: AppSourceErrorReason; message: string };

/** One cell of an external table: coerced by the column's type (objects arrive as JSON text). */
export type AppSourceCell = string | number | boolean | null;

export interface AppSourceTableResult {
  kind: 'table';
  columns: Array<{ key: string; label: string; type: AppSourceColumnType }>;
  /** Keyed by column key. */
  rows: Array<Record<string, AppSourceCell>>;
  /** More rows than `APP_SOURCE_LIMITS.rows` came back; the rest were dropped. */
  truncated: boolean;
}

/**
 * The same shape as `McpNeedsConnection` (`@greenhouse/types/mcp-servers`),
 * repeated here so this contract stays vendorable on its own; a type test pins
 * the two to each other.
 */
export interface AppSourceNeedsConnection {
  needs_connection: true;
  server: string;
  server_name: string;
  server_id: number;
  auth: 'per_user' | 'oauth';
  reason: 'not_connected' | 'expired';
  error: string;
}

/**
 * Why an external card has no data this time: `failed` (the tool answered an
 * error), `timeout`, `too_large` (over `APP_SOURCE_LIMITS.resultBytes`),
 * `not_read_only` (the connector no longer reports the tool read-only),
 * `not_allowed` (not in the viewer's own tools / connectors), `map` (the answer
 * does not have what the map points at).
 */
export type AppSourceErrorReason = 'failed' | 'timeout' | 'too_large' | 'not_read_only' | 'not_allowed' | 'map';

/** `POST /api/apps/:id/records/get`. */
export interface AppRecordGetInput {
  /** Custom cards: the stored records binding to open. */
  bindingId?: string;
  pageId: string;
  cardId: string;
  recordId: number;
  previewRole?: string;
  /** Managers only: through the draft (slice G; additive). */
  draft?: boolean;
}

/** The record drawer: `detail.fieldIds` ∩ readable, what may be edited, and what the drawer may show. */
export interface AppRecordView {
  record: AppRecordRow;
  refs: AppRecordRefs;
  /** In display order. */
  fieldIds: number[];
  systemFields: TableSystemField[];
  /** `detail.editableFieldIds` ∩ role editable, empty outside `editRows` (write with `$edit`). */
  editableFieldIds: number[];
  /** `detail.comments && role.canComment`. */
  canComment: boolean;
}

/** `POST /api/apps/:id/actions` (input `AppActionInput`, plus `buttonId` for a `create_record` button). */
export interface AppActionResult {
  outcome: 'updated' | 'created' | 'deleted' | 'queued';
  recordId: number;
  /** The record as the viewer now reads it; absent when it left their scope (or was deleted). */
  record?: AppRecordRow;
  /** `run_automation`: the queued run. */
  runId?: number;
  /** The same `requestId` already ran; this is its first result. */
  replayed?: boolean;
}

/**
 * Why `/actions` refused, in `details.reason` (status in brackets):
 * `precondition` (409, `when` no longer holds), `conflict` (409, stale revision —
 * `details.currentRevision`), `required_input` (400, `details.fieldIds`),
 * `not_allowed` (403, role / capability), `not_found` (404, outside scope).
 */
export type AppActionRefusal = 'precondition' | 'conflict' | 'required_input' | 'not_allowed' | 'not_found';

/** `POST /api/apps/:id/activity` → `TableRecordActivityPage` (role-readable ∩ detail fields only). */
export interface AppActivityInput {
  pageId: string;
  cardId: string;
  recordId: number;
  cursor?: string;
  /** Managers only (slice G; additive). */
  previewRole?: string;
  draft?: boolean;
}

/** `POST /api/apps/:id/comments` → `{ comment: TableRecordCommentView }`; `PATCH|DELETE /comments/:commentId` with `{pageId, cardId}`. */
export interface AppCommentInput {
  pageId: string;
  cardId: string;
  recordId: number;
  body: string;
  /** Managers only (slice G; additive). */
  previewRole?: string;
  draft?: boolean;
}

/** `POST /api/apps/:id/options`: choices for a user or relation field the card lets this role write. */
export interface AppFieldOptionsInput {
  pageId: string;
  cardId: string;
  fieldId: number;
  search?: string;
  /** `create_record` buttons. */
  buttonId?: string;
  /** Managers only (slice G; additive). */
  previewRole?: string;
  draft?: boolean;
}

export interface AppFieldOptionsView {
  /** User fields: `value` = user id; relation fields: `value` = record id. */
  options: Array<{ value: string | number; label: string; detail?: string }>;
}

/** `POST /api/apps/:id/uploads` (multipart `file`, `pageId`, `cardId`, `fieldId`) → `{ file }`, bound on the next write. */
export type AppUploadView = TableFormUploadView;

/** `GET /api/apps/:id/usage` (managers): counted from the app-scoped audit. */
export interface AppUsageView {
  users7d: number;
  users30d: number;
  /** Action id (incl. `$submit` / `$create` / `$move` / `$edit`) → runs in the last 30 days. */
  actions30d: Record<string, number>;
  lastUsedAt: string | null;
}

/** `GET /api/apps/templates` → `{ templates }`; `POST /api/apps/templates/:key/install` → `AppTemplateInstallResult`. */
export interface AppTemplateSummary {
  key: string;
  name: string;
  description: string;
  icon: AppIconName;
  accent: AppAccent;
  /** Where it comes from (Phase 2 lifecycle; additive — absent from Phase 1 servers = built-in). */
  source?: AppTemplateSource;
  /** The version an install gets (semver). */
  version?: string;
  /** That version's review state (installs by anyone but its publisher need `approved` or `not_required`). */
  reviewStatus?: AppTemplateReviewStatus;
}

// ─── Template lifecycle (Phase 2 §6; additive) ─────────────
//
// `table_app_templates` + `table_app_template_versions`: built-in templates
// (`source: 'builtin'`, synced from the repo at boot) and templates members
// publish from an app ("save as template"). Versions are immutable semver with a
// changelog; content is hashed; a scan runs before a version is stored; versions
// carrying custom cards or automations need a super's review before anyone else
// installs them. Installing creates a NEW Base + a draft app through the plan
// path (D9), automations disabled, executor = the installer; never idempotent (D12).

export type AppTemplateSource = 'builtin' | 'published';
export type AppTemplateStatus = 'active' | 'archived';
/** `not_required` = no custom cards and no automations. */
export type AppTemplateReviewStatus = 'not_required' | 'pending' | 'approved' | 'rejected';
/** The content scan's verdict (as the skill center's); `blocked` is sticky until a super lifts it. */
export type AppTemplateScanStatus = 'pending' | 'clean' | 'suspicious' | 'blocked';

export interface AppTemplateVersionView {
  version: string;
  changelog: string;
  contentHash: string;
  scanStatus: AppTemplateScanStatus;
  reviewStatus: AppTemplateReviewStatus;
  /** Why review is required: what the version carries. */
  carries: { customCards: number; automations: number };
  /** Null for built-in versions. */
  publishedBy: { id: string; name: string } | null;
  publishedAt: string;
  reviewedBy?: { id: string; name: string };
  reviewedAt?: string;
  reviewNote?: string;
}

/** `GET /api/apps/templates/:key`. */
export interface AppTemplateDetailView {
  template: AppTemplateSummary & {
    source: AppTemplateSource;
    status: AppTemplateStatus;
    /** Null for built-in templates. */
    owner: { id: string; name: string } | null;
    /** The caller may publish a new version / archive it (its owner, or a super). */
    canManage: boolean;
    /** The caller is a super (may review). */
    canReview: boolean;
  };
  /** Newest first. */
  versions: AppTemplateVersionView[];
  /** What installing the current version creates, in the reader's language. */
  creates?: { tables: Array<{ name: string; fields: number }>; automations: number; dashboards: number; pages: number };
}

/**
 * `POST /api/apps/templates` (a new template, `version` = its first) and
 * `POST /api/apps/templates/:key/versions` (a new version of a template the
 * caller owns): "save as template" from an app they manage. Structure and spec
 * only — sample records are the ones written here, never exported from the Base.
 */
export interface AppTemplatePublishInput {
  appId: number;
  /** New template only. */
  key?: string;
  name?: string;
  description?: string;
  icon?: AppIconName;
  accent?: AppAccent;
  /** Strict semver, greater than the latest. */
  version: string;
  /** Required for every version after the first. */
  changelog?: string;
  /** Hand-written sample records, by the source Base's table ids (≤ `APP_TEMPLATE_LIMITS.sampleRecords`). */
  sampleRecords?: Array<{ tableId: number; values: TableFieldValueEntry[] }>;
}

/** `POST /api/apps/templates/:key/versions/:version/review` (super). */
export interface AppTemplateReviewInput {
  decision: 'approve' | 'reject';
  note?: string;
}

export const APP_TEMPLATE_LIMITS = Object.freeze({
  keyLength: 40,
  changelogLength: 2_000,
  sampleRecords: 50,
  /** The stored template content (JSON text). */
  contentBytes: 1024 * 1024,
});

// ─── Custom-code review (Phase 2 §1, D10; additive) ────────

/** `POST /api/apps/:id/versions/:version/review` (super): approve / reject exactly `hash` (the version's `specHash`). */
export interface AppCustomReviewInput {
  hash: string;
  decision: 'approve' | 'reject';
  note?: string;
}

/** `GET /api/apps/reviews` (super): one version waiting for (or given) a custom-code review. */
export interface AppCustomReviewItem {
  app: { id: number; name: string; baseId: number; ownerId: string };
  version: number;
  specHash: string;
  review: AppCustomReview;
  publishedBy: { id: string; name: string };
  publishedAt: string;
  /** The version's custom cards, as a reviewer reads them. */
  cards: Array<{
    pageId: string;
    cardId: string;
    title?: string;
    html: string;
    bindings: AppCustomBinding[];
    actions: AppCustomAction[];
    create?: AppCustomCreate;
  }>;
  /** The last approved version of the same app, for a diff (absent = none). */
  previous?: { version: number; cards: Array<{ pageId: string; cardId: string; html: string }> };
}

export interface AppTemplateInstallResult {
  app: AppSummary;
  baseId: number;
}

/**
 * One place an app uses what a schema change removes (D6). `where` words it in
 * English (`v2 › “Review” › “Pending” › “Approve”`) for logs, the plan tool and
 * older clients. The optional fields say the same thing language-neutrally so a
 * client words it in its own language (additive): the `version` (a published
 * one or the draft), the `page`, and then one of — a page `filter`, a `card`
 * (alone, with one of its `action`s / buttons, or its lane `move`) — or, with
 * no page, a `role`'s table rules.
 */
export interface AppReference {
  appId: number;
  name: string;
  where: string;
  version?: number | 'draft';
  page?: { id: string; title: string };
  filter?: { id: string; label: string };
  /** `title` absent = an untitled card (name it by its kind). */
  card?: { id: string; kind: AppCardKind; title?: string };
  /** A card action, a drawer action or a button of a buttons card. */
  action?: { id: string; label: string };
  /** The board card's lane move (its `move.when`). */
  move?: true;
  role?: { key: string; name: string };
}

/** 409 `details` when a schema change would break apps (D6); resend with `confirm: true` to proceed. */
export interface AppReferencesConflict {
  reason: 'used_by_apps';
  references: AppReference[];
}
