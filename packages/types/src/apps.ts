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
  TableSystemField,
} from './tables.js';
import type { TableAccessRule } from './table-access.js';

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
] as const satisfies readonly AppCardKind[];

/**
 * Card kinds the mobile app draws natively. Requests from mobile declare this
 * list; an older build meeting a newer kind shows "open on the web" instead of
 * crashing.
 */
export const MOBILE_APP_CARDS: readonly AppCardKind[] = APP_CARD_KINDS;

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
        case 'text':
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
    fields: Array<{
      id: number;
      name: string;
      type: string;
      isPrimary: boolean;
      config: unknown;
      editable: boolean;
    }>;
  }>;
  issues: AppIssue[];
}

export interface AppCardQueryInput {
  pageId: string;
  cardId: string;
  filterValues?: Record<string, TableFilterValue>;
  timezone?: string;
  cursor?: string;
  search?: string;
  /** Managers only: evaluate as this role. */
  previewRole?: string;
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
}

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
