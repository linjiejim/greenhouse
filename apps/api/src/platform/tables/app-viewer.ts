/**
 * The app as one role receives it (`GET /api/apps/:id`, docs/specs/20261011-tables-apps.md
 * §3–§4): the spec trimmed to the role (`trimSpecForRole` — its pages, the
 * actions / forms / create / move / buttons it may use), field metadata for
 * the fields it reads, and the D6 issues of its pages.
 *
 * On top of the role trim, a viewer never receives what their role cannot
 * read — the same rule Phase 0 applies to a custom role's dashboards and forms:
 * - the role's own table rules (row predicates, hidden field ids) are
 *   withheld (`tables: []`); what the client needs is in `tables[].fields`
 *   (`editable`);
 * - field lists keep readable fields only (editable lists: editable ones;
 *   form / create inputs: fields the role may write);
 * - builder-written predicates that name an unreadable field (a card query,
 *   an action's `when`, a move precondition) and defaults on unreadable fields
 *   are dropped from the copy — the server still applies them;
 * - an embedded kpi / chart / pivot whose query needs an unreadable field is
 *   reduced to its kind (its constants would disclose hidden values); the
 *   gateway answers it `no_access`;
 * - page filters lose targets on unreadable fields (a control left empty is
 *   dropped), and issue messages are generic (they name fields).
 * Managers previewing a role get the same copy (what the role will see), with
 * the detailed issue messages.
 */

import type {
  AppButton,
  AppCard,
  AppIssue,
  AppPage,
  AppRecordAction,
  AppRuntimeView,
  AppSpec,
  AppSummary,
} from '@greenhouse/types/apps';
import { trimCardForReader, trimFilterControlsForReader } from '@greenhouse/types/table-cards';
import type { TableFieldValueEntry, TableFilterGroup } from '@greenhouse/types/tables';
import { pageClauses, queryFieldIds } from './app-scope.js';
import { sessionCanCreate, sessionEditable, sessionReadable, type AppSession } from './app-session.js';
import { revalidateSpec } from './app-spec.js';
import { appRuntimeView } from './app-view.js';

type ReadableFor = (tableId: number) => ReadonlySet<number> | null | undefined;
type EditableFor = (tableId: number) => ReadonlySet<number> | null | undefined;
type CanCreateFor = (tableId: number) => boolean;

function readsAll(readable: ReadonlySet<number> | null | undefined, ids: readonly number[]): boolean {
  if (readable === null) return true;
  if (!readable) return false;
  return ids.every((id) => readable.has(id));
}

function keep(ids: readonly number[], allowed: ReadonlySet<number> | null | undefined): number[] {
  if (allowed === null) return [...ids];
  if (!allowed) return [];
  return ids.filter((id) => allowed.has(id));
}

function groupFields(group: TableFilterGroup | undefined): number[] {
  return (group?.clauses ?? []).flatMap((clause) => (clause.fieldId !== undefined ? [clause.fieldId] : []));
}

function trimDefaults(
  defaults: TableFieldValueEntry[] | undefined,
  readable: ReadonlySet<number> | null | undefined,
): TableFieldValueEntry[] | undefined {
  if (!defaults) return undefined;
  const kept = defaults.filter((entry) => readable === null || Boolean(readable?.has(entry.fieldId)));
  return kept.length > 0 ? kept : undefined;
}

function trimAction(action: AppRecordAction, readable: ReadonlySet<number> | null | undefined): AppRecordAction {
  const out: AppRecordAction = { ...action };
  if (out.when && !readsAll(readable, groupFields(out.when))) delete out.when;
  return out;
}

function trimRecordsCard(
  card: Extract<AppCard, { kind: 'records' | 'kanban' | 'calendar' | 'gallery' }>,
  readable: ReadonlySet<number> | null | undefined,
  editable: ReadonlySet<number> | null | undefined,
  canCreate: boolean,
): AppCard {
  const out = { ...card, fieldIds: keep(card.fieldIds, readable) } as typeof card;
  const query = out.source.query;
  const named = [
    ...queryFieldIds(query),
    ...pageClauses(query).flatMap((ref) => (ref.clause.fieldId !== undefined ? [ref.clause.fieldId] : [])),
  ];
  if (query && !readsAll(readable, named)) out.source = { tableId: out.source.tableId };
  if ((out.kind === 'kanban' || out.kind === 'gallery') && out.coverFieldId !== undefined) {
    if (!readsAll(readable, [out.coverFieldId])) delete out.coverFieldId;
  }
  if (out.actions) out.actions = out.actions.map((action) => trimAction(action, readable));
  if (out.detail) {
    const detail = { ...out.detail, fieldIds: keep(out.detail.fieldIds, readable) };
    if (detail.editableFieldIds) detail.editableFieldIds = keep(detail.editableFieldIds, editable);
    if (detail.actions) detail.actions = detail.actions.map((action) => trimAction(action, readable));
    out.detail = detail;
  }
  // A role whose rule cannot create never sees the "New" entry point (the write would be refused).
  if (out.kind === 'records' && out.create && !canCreate) delete out.create;
  if (out.kind === 'records' && out.create) {
    const create = { ...out.create, fieldIds: keep(out.create.fieldIds, editable) };
    const defaults = trimDefaults(create.defaults, readable);
    if (defaults) create.defaults = defaults;
    else delete create.defaults;
    out.create = create;
  }
  if (out.kind === 'kanban' && out.move?.when && !readsAll(readable, groupFields(out.move.when))) {
    out.move = { ...out.move };
    delete out.move.when;
  }
  return out;
}

function trimButton(button: AppButton, readableFor: ReadableFor, editableFor: EditableFor): AppButton {
  if (button.type !== 'create_record') return button;
  const out = { ...button, fieldIds: keep(button.fieldIds, editableFor(button.tableId)) };
  const defaults = trimDefaults(out.defaults, readableFor(button.tableId));
  if (defaults) out.defaults = defaults;
  else delete out.defaults;
  return out;
}

function trimCard(
  card: AppCard,
  readableFor: ReadableFor,
  editableFor: EditableFor,
  canCreateFor: CanCreateFor,
): AppCard {
  switch (card.kind) {
    case 'records':
    case 'kanban':
    case 'calendar':
    case 'gallery':
      return trimRecordsCard(
        card,
        readableFor(card.source.tableId),
        editableFor(card.source.tableId),
        canCreateFor(card.source.tableId),
      );
    case 'form': {
      const out = { ...card, fieldIds: keep(card.fieldIds, editableFor(card.tableId)) };
      const defaults = trimDefaults(out.defaults, readableFor(card.tableId));
      if (defaults) out.defaults = defaults;
      else delete out.defaults;
      return out;
    }
    case 'kpi':
    case 'chart':
    case 'pivot': {
      const tableId = card.card.source?.tableId;
      const trimmed = tableId === undefined ? card.card : trimCardForReader(card.card, readableFor(tableId));
      return { ...card, card: trimmed ?? { kind: card.card.kind } };
    }
    case 'buttons':
      return {
        ...card,
        buttons: card.buttons
          .filter((button) => button.type !== 'create_record' || canCreateFor(button.tableId))
          .map((button) => trimButton(button, readableFor, editableFor)),
      };
    case 'text':
      return card;
  }
}

/** The role-trimmed spec with everything the role cannot read removed (see the module comment). */
export function viewerSpec(
  spec: AppSpec,
  readableFor: ReadableFor,
  editableFor: EditableFor,
  canCreateFor: CanCreateFor = () => true,
): AppSpec {
  return {
    ...spec,
    roles: spec.roles.map((role) => ({ ...role, tables: [] })),
    pages: spec.pages.map(
      (page): AppPage => ({
        ...page,
        ...(page.filters ? { filters: trimFilterControlsForReader(page.filters, readableFor) } : {}),
        cards: page.cards.map((card) => trimCard(card, readableFor, editableFor, canCreateFor)),
      }),
    ),
  };
}

function genericIssue(issue: AppIssue): AppIssue {
  return {
    ...issue,
    message: issue.actionId
      ? 'This action is unavailable'
      : issue.filterId
        ? 'This filter is unavailable'
        : 'This card is unavailable',
  };
}

/**
 * The runtime view for the role in play: a viewer's (generic issue messages)
 * or a manager's preview. `summary` is the caller's app summary.
 */
export async function roleRuntimeView(session: AppSession, summary: AppSummary): Promise<AppRuntimeView | undefined> {
  if (!session.role) return undefined;
  const schema = await session.schema();
  const view = await appRuntimeView({
    app: summary,
    version: session.version,
    draft: session.draft,
    spec: session.spec,
    schema,
    issues: await revalidateSpec(session.spec, schema),
    roleKey: session.role.key,
  });
  if (!view) return undefined;
  const [readableFor, editableFor, canCreateFor] = await Promise.all([
    sessionReadable(session),
    sessionEditable(session),
    sessionCanCreate(session),
  ]);
  return {
    ...view,
    spec: viewerSpec(view.spec, readableFor, editableFor, canCreateFor),
    issues: session.manager ? view.issues : view.issues.map(genericIssue),
  };
}
