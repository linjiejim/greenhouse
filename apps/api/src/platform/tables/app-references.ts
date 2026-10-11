/**
 * Structure changes that would break apps (docs/specs/20261011-tables-apps.md
 * §5, D6): archiving a table or field, removing select options, deleting an
 * automation rule. Published versions are immutable but the schema is not, so
 * those changes answer 409 `used_by_apps` with where each draft or published
 * version of a live (not archived) app on the Base uses the object — unless
 * the caller resends with `confirm: true`; the runtime then serves the
 * affected cards / actions / filters as unavailable (`revalidateSpec`).
 *
 * `specPlaces` walks a spec once and names each place: a page filter, a card
 * (source, columns, detail, create spec, query, aggregate), a card action or
 * the lane move, a button, a role's table rules (fields, row predicates). It
 * covers everything `appSpecDependencies` lists (a parity test keeps it so),
 * plus option ids in predicates and values, which the dependency list does not
 * carry. Each place comes twice: structured and language-neutral (the
 * `AppReference` fields a client words in its own language) and as the English
 * `where` the plan tool shows the model.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type {
  AppButton,
  AppCard,
  AppPage,
  AppRecordAction,
  AppReference,
  AppReferencesConflict,
  AppRole,
  AppSpec,
} from '@greenhouse/types/apps';
import type { TableRowScope } from '@greenhouse/types/table-access';
import type { TableFieldValueEntry, TableFilterControl, TableFilterGroup, TableQuery } from '@greenhouse/types/tables';
import type { PlatformActionResult } from '@greenhouse/platform-kernel';
import { parseStoredAppSpec } from './app-spec.js';
import { fail } from './handlers/shared.js';

/** What a structure change takes away. */
export interface AppReferenceTarget {
  tableIds?: readonly number[];
  fieldIds?: readonly number[];
  ruleIds?: readonly number[];
  /** Select options removed from one field. */
  options?: { fieldId: number; optionIds: readonly string[] };
}

/** What one place in a spec holds. */
interface Holdings {
  tables: Set<number>;
  fields: Set<number>;
  rules: Set<number>;
  /** `<fieldId>:<optionId>` of option values in predicates and values. */
  options: Set<string>;
}

function holdings(): Holdings {
  return { tables: new Set(), fields: new Set(), rules: new Set(), options: new Set() };
}

function addValueOptions(into: Holdings, fieldId: number | undefined, value: unknown): void {
  if (fieldId === undefined) return;
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry === 'string' && entry) into.options.add(`${fieldId}:${entry}`);
  }
}

function addGroup(into: Holdings, group: TableFilterGroup | undefined): void {
  for (const clause of group?.clauses ?? []) {
    if (clause.fieldId === undefined) continue;
    into.fields.add(clause.fieldId);
    addValueOptions(into, clause.fieldId, clause.value);
  }
}

function addQuery(into: Holdings, query: Omit<TableQuery, 'cursor' | 'limit'> | undefined): void {
  if (!query) return;
  addGroup(into, query.where);
  for (const group of query.filters ?? []) addGroup(into, group);
  for (const sort of query.sort ?? []) if (sort.fieldId !== undefined) into.fields.add(sort.fieldId);
  if (query.groupBy?.fieldId !== undefined) into.fields.add(query.groupBy.fieldId);
}

function addValues(into: Holdings, entries: readonly TableFieldValueEntry[] | undefined): void {
  for (const entry of entries ?? []) {
    into.fields.add(entry.fieldId);
    addValueOptions(into, entry.fieldId, entry.value);
  }
}

function addFields(into: Holdings, ids: readonly number[] | undefined): void {
  for (const id of ids ?? []) into.fields.add(id);
}

function addRowScope(into: Holdings, scope: TableRowScope | undefined): void {
  if (!scope) return;
  if (scope.type === 'related') addFields(into, scope.fieldIds);
  if (scope.type === 'where') addGroup(into, scope.where);
}

function controlHoldings(control: TableFilterControl): Holdings {
  const into = holdings();
  for (const target of control.targets) {
    into.tables.add(target.tableId);
    if (target.fieldId !== undefined) into.fields.add(target.fieldId);
  }
  const value = control.defaultValue;
  if (value?.kind === 'select') {
    for (const target of control.targets) addValueOptions(into, target.fieldId, value.values);
  }
  return into;
}

function actionHoldings(action: AppRecordAction): Holdings {
  const into = holdings();
  addGroup(into, action.when);
  if (action.do.type === 'set_fields') {
    addValues(into, action.do.values);
    addFields(into, action.do.inputFieldIds);
  }
  if (action.do.type === 'run_automation') into.rules.add(action.do.ruleId);
  return into;
}

function buttonHoldings(button: AppButton): Holdings {
  const into = holdings();
  if (button.type === 'create_record') {
    into.tables.add(button.tableId);
    addFields(into, button.fieldIds);
    addValues(into, button.defaults);
  }
  return into;
}

/** The card itself — not its actions, lane move or buttons (those are their own places). */
function cardHoldings(card: AppCard): Holdings {
  const into = holdings();
  switch (card.kind) {
    case 'records':
    case 'kanban':
    case 'calendar':
    case 'gallery':
      into.tables.add(card.source.tableId);
      addQuery(into, card.source.query);
      addFields(into, card.fieldIds);
      if (card.kind === 'kanban') into.fields.add(card.groupFieldId);
      if (card.kind === 'calendar') {
        into.fields.add(card.startFieldId);
        if (card.endFieldId !== undefined) into.fields.add(card.endFieldId);
      }
      if ((card.kind === 'kanban' || card.kind === 'gallery') && card.coverFieldId !== undefined) {
        into.fields.add(card.coverFieldId);
      }
      addFields(into, card.detail?.fieldIds);
      addFields(into, card.detail?.editableFieldIds);
      if (card.kind === 'records' && card.create) {
        addFields(into, card.create.fieldIds);
        addValues(into, card.create.defaults);
      }
      break;
    case 'form':
      into.tables.add(card.tableId);
      addFields(into, card.fieldIds);
      addValues(into, card.defaults);
      break;
    case 'kpi':
    case 'chart':
    case 'pivot': {
      if (card.card.source) {
        into.tables.add(card.card.source.tableId);
        addQuery(into, card.card.source.query);
      }
      const aggregate = card.card.aggregate;
      if (aggregate?.valueFieldId !== undefined) into.fields.add(aggregate.valueFieldId);
      if (aggregate?.groupBy?.fieldId !== undefined) into.fields.add(aggregate.groupBy.fieldId);
      if (aggregate?.series?.fieldId !== undefined) into.fields.add(aggregate.series.fieldId);
      break;
    }
    case 'text':
    case 'buttons':
      break;
  }
  return into;
}

function roleHoldings(role: AppRole): Holdings {
  const into = holdings();
  for (const rule of role.tables) {
    into.tables.add(rule.tableId);
    for (const entry of rule.fields ?? []) into.fields.add(entry.fieldId);
    addRowScope(into, rule.rows);
    addRowScope(into, rule.editRows);
  }
  return into;
}

/** Where a place is, without words: the `AppReference` fields after `appId` / `name` / `where`. */
export type SpecPlaceLocation = Omit<AppReference, 'appId' | 'name' | 'where'>;

export interface SpecPlace {
  /** The place in English (`v2 › “Review” › “Pending” › “Approve”`). */
  where: string;
  location: SpecPlaceLocation;
  holds: Holdings;
}

const quote = (text: string) => `“${text}”`;

/** The English words for a place (the plan tool's problems, logs, older clients). */
function placeWords(location: SpecPlaceLocation): string {
  const parts = [location.version === 'draft' ? 'draft' : `v${location.version}`];
  if (location.page) parts.push(quote(location.page.title));
  if (location.filter) parts.push(`filter ${quote(location.filter.label)}`);
  if (location.card) parts.push(quote(location.card.title ?? location.card.id));
  if (location.action) parts.push(quote(location.action.label));
  if (location.move) parts.push('move');
  if (location.role) parts.push(`role ${quote(location.role.name)}`);
  return parts.join(' › ');
}

/** Every place of a spec with what it holds, in `version` (a published version number, or the draft). */
export function specPlaces(spec: AppSpec, version: number | 'draft'): SpecPlace[] {
  const places: SpecPlace[] = [];
  const add = (location: Omit<SpecPlaceLocation, 'version'>, holds: Holdings) => {
    const full: SpecPlaceLocation = { version, ...location };
    places.push({ where: placeWords(full), location: full, holds });
  };
  for (const page of spec.pages as AppPage[]) {
    const pageRef = { id: page.id, title: page.title };
    for (const control of page.filters ?? []) {
      add({ page: pageRef, filter: { id: control.id, label: control.label } }, controlHoldings(control));
    }
    for (const card of page.cards) {
      const cardRef = { id: card.id, kind: card.kind, ...(card.title ? { title: card.title } : {}) };
      add({ page: pageRef, card: cardRef }, cardHoldings(card));
      if (card.kind === 'records' || card.kind === 'kanban' || card.kind === 'calendar' || card.kind === 'gallery') {
        for (const action of [...(card.actions ?? []), ...(card.detail?.actions ?? [])]) {
          add({ page: pageRef, card: cardRef, action: { id: action.id, label: action.label } }, actionHoldings(action));
        }
        if (card.kind === 'kanban' && card.move?.when) {
          const holds = holdings();
          addGroup(holds, card.move.when);
          add({ page: pageRef, card: cardRef, move: true }, holds);
        }
      }
      if (card.kind === 'buttons') {
        for (const button of card.buttons) {
          add({ page: pageRef, card: cardRef, action: { id: button.id, label: button.label } }, buttonHoldings(button));
        }
      }
    }
  }
  for (const role of spec.roles) add({ role: { key: role.key, name: role.name } }, roleHoldings(role));
  return places;
}

function hits(holds: Holdings, target: AppReferenceTarget): boolean {
  if (target.tableIds?.some((id) => holds.tables.has(id))) return true;
  if (target.fieldIds?.some((id) => holds.fields.has(id))) return true;
  if (target.ruleIds?.some((id) => holds.rules.has(id))) return true;
  const options = target.options;
  return Boolean(options?.optionIds.some((id) => holds.options.has(`${options.fieldId}:${id}`)));
}

/** The places of `spec` that use `target`. */
export function specReferences(spec: AppSpec, target: AppReferenceTarget, version: number | 'draft'): SpecPlace[] {
  return specPlaces(spec, version).filter((place) => hits(place.holds, target));
}

const MAX_PLACES_PER_APP = 20;

/** Where the drafts and published versions of the Base's live apps use `target`. */
export async function appReferencesTo(
  db: DatabaseProvider,
  baseId: number,
  target: AppReferenceTarget,
): Promise<AppReferencesConflict['references']> {
  const references: AppReferencesConflict['references'] = [];
  for (const summary of await db.tables.listAppsForBase(baseId)) {
    const app = await db.tables.getApp(summary.id);
    if (!app || app.archived_at) continue;
    // One entry per place (two same-titled cards are two places: the key carries ids).
    const places = new Map<string, SpecPlace>();
    const collect = (found: SpecPlace[]) => {
      for (const place of found) places.set(JSON.stringify(place.location), place);
    };
    const draft = parseStoredAppSpec(app.draft_spec);
    if (draft) collect(specReferences(draft, target, 'draft'));
    if (app.published_version) {
      const version = await db.tables.getAppVersion(app.id, app.published_version);
      const live = version ? parseStoredAppSpec(version.spec) : undefined;
      if (live) collect(specReferences(live, target, app.published_version));
    }
    for (const place of [...places.values()].slice(0, MAX_PLACES_PER_APP)) {
      references.push({ appId: app.id, name: app.name, where: place.where, ...place.location });
    }
  }
  return references;
}

/**
 * The D6 gate of a structure change: 409 `used_by_apps` with the places, or
 * undefined to proceed (nothing uses it, or the caller confirmed).
 */
export async function usedByApps(
  db: DatabaseProvider,
  baseId: number,
  target: AppReferenceTarget,
  confirm: unknown,
): Promise<PlatformActionResult | undefined> {
  if (confirm === true) return undefined;
  const references = await appReferencesTo(db, baseId, target);
  if (references.length === 0) return undefined;
  const details: AppReferencesConflict = { reason: 'used_by_apps', references };
  return fail('CONFLICT', 'Apps use this — confirm to change it anyway', { ...details });
}
