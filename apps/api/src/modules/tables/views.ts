/**
 * View settings: what a new view of each type starts with, and a saved config kept to the
 * table's live fields (a deleted field leaves every view it was in).
 */

import {
  canGroupBy,
  canSortBy,
  isSystemField,
  operatorsFor,
  type ViewConfig,
  type ViewType,
} from '@greenhouse/contract';
import type { BaseFieldRow } from '@greenhouse/db';
import { invalidInput } from '../../http/errors.js';

/** A grid shows the primary field and five more; the rest start hidden (content.md). */
const DEFAULT_COLUMNS = 6;

const first = (fields: readonly BaseFieldRow[], ...types: BaseFieldRow['type'][]) =>
  fields.find((field) => types.includes(field.type));

/** The starting settings of a view type, from the table's fields. Null: the table lacks what it needs. */
export function defaultConfig(type: ViewType, fields: readonly BaseFieldRow[]): ViewConfig | null {
  const hidden = fields
    .filter((field) => !field.isPrimary)
    .slice(DEFAULT_COLUMNS - 1)
    .map((field) => field.id);
  switch (type) {
    case 'grid':
      return hidden.length ? { hidden } : {};
    case 'kanban': {
      const lanes =
        first(fields, 'single_select') ?? fields.find((field) => field.type === 'member' && !field.config.multiple);
      return lanes ? { kanban: { field: lanes.id }, hidden } : null;
    }
    case 'calendar': {
      const start = first(fields, 'date', 'datetime');
      return start ? { calendar: { start: start.id }, hidden } : null;
    }
    case 'gallery': {
      const cover = first(fields, 'attachment');
      return { gallery: cover ? { cover: cover.id } : {}, hidden };
    }
    case 'timeline': {
      const dates = fields.filter((field) => field.type === 'date' || field.type === 'datetime');
      if (!dates.length) return null;
      const dependency = first(fields, 'dependency');
      return {
        timeline: {
          start: dates[0]!.id,
          ...(dates[1] ? { end: dates[1].id } : {}),
          ...(dependency ? { dependency: dependency.id } : {}),
          scale: 'week',
        },
        hidden,
      };
    }
    case 'dashboard':
      return { cards: [] };
  }
}

/**
 * A config checked against its type and the table's live fields: references to fields that are
 * gone are dropped, and settings must fit the fields they name. Strict (a member saving a view)
 * refuses what does not fit; lenient (fields changed under the view) drops it.
 */
export function cleanConfig(
  type: ViewType,
  config: ViewConfig,
  fields: readonly BaseFieldRow[],
  mode: 'strict' | 'lenient' = 'strict',
): ViewConfig {
  const byId = new Map(fields.map((field) => [field.id, field]));
  /** Refuses in strict mode; in lenient mode the caller drops the setting. */
  const misfit = (message: string) => {
    if (mode === 'strict') throw invalidInput(message);
    return false;
  };
  const live = (id: string | undefined) => (id ? byId.get(id) : undefined);
  const known = (id: string) => isSystemField(id) || byId.has(id);
  const out: ViewConfig = {};
  if (config.filter) {
    const clauses = config.filter.clauses.filter((clause) => {
      if (!known(clause.field)) return false;
      const kind = isSystemField(clause.field) ? clause.field : byId.get(clause.field)!.type;
      return operatorsFor(kind).includes(clause.op) || misfit(`A filter cannot use ${clause.op} there.`);
    });
    if (clauses.length) out.filter = { mode: config.filter.mode, clauses };
  }
  if (config.sorts) {
    const sorts = config.sorts.filter((sort) => {
      if (!known(sort.field)) return false;
      if (isSystemField(sort.field) || canSortBy(byId.get(sort.field)!.type)) return true;
      return misfit(`Records cannot be sorted by 「${byId.get(sort.field)!.name}」.`);
    });
    if (sorts.length) out.sorts = sorts;
  }
  if (config.group && known(config.group.field)) {
    const kind = isSystemField(config.group.field) ? config.group.field : byId.get(config.group.field)!.type;
    if (canGroupBy(kind) || misfit('Records cannot be grouped by that field.')) out.group = config.group;
  }
  if (config.order) out.order = config.order.filter((id) => byId.has(id));
  if (config.hidden) {
    const hidden = config.hidden.filter((id) => byId.has(id) && !byId.get(id)!.isPrimary);
    if (hidden.length) out.hidden = hidden;
  }
  if (config.widths) {
    const widths = Object.fromEntries(Object.entries(config.widths).filter(([id]) => byId.has(id)));
    if (Object.keys(widths).length) out.widths = widths;
  }
  if (config.frozen !== undefined) out.frozen = config.frozen;
  if (config.row_height) out.row_height = config.row_height;

  if (type === 'kanban') {
    const lanes = live(config.kanban?.field);
    if (lanes && (lanes.type === 'single_select' || (lanes.type === 'member' && !lanes.config.multiple))) {
      out.kanban = { field: lanes.id, ...(config.kanban?.hide_empty ? { hide_empty: true } : {}) };
    } else if (config.kanban?.field && byId.has(config.kanban.field)) {
      misfit('A kanban needs a single select or a single member field.');
    }
  }
  if (type === 'calendar') {
    const start = live(config.calendar?.start);
    const end = live(config.calendar?.end);
    const isDate = (field: BaseFieldRow | undefined) => field?.type === 'date' || field?.type === 'datetime';
    if (start && !isDate(start)) misfit('A calendar needs a date field.');
    else if (start) out.calendar = { start: start.id, ...(isDate(end) ? { end: end!.id } : {}) };
  }
  if (type === 'gallery') {
    const cover = live(config.gallery?.cover);
    out.gallery = cover?.type === 'attachment' ? { cover: cover.id } : {};
  }
  if (type === 'timeline' && config.timeline) {
    const timeline = config.timeline;
    const isDate = (field: BaseFieldRow | undefined) => field?.type === 'date' || field?.type === 'datetime';
    const start = live(timeline.start);
    if (start && !isDate(start)) misfit('A timeline needs a date field to start from.');
    else if (start) {
      const end = live(timeline.end);
      const dependency = live(timeline.dependency);
      const milestone = live(timeline.milestone?.field);
      out.timeline = {
        start: start.id,
        ...(isDate(end) && end!.id !== start.id ? { end: end!.id } : {}),
        ...(dependency?.type === 'dependency' ? { dependency: dependency.id } : {}),
        ...(milestone?.type === 'checkbox'
          ? { milestone: { field: milestone.id } }
          : milestone?.type === 'single_select' &&
              milestone.config.options?.some((option) => option.id === timeline.milestone?.option)
            ? { milestone: { field: milestone.id, option: timeline.milestone!.option! } }
            : {}),
        scale: timeline.scale ?? 'week',
      };
    }
  }
  return out;
}

/** Whether a type has what it needs to show anything. */
export function viewReady(type: ViewType, config: ViewConfig): boolean {
  if (type === 'kanban') return !!config.kanban;
  if (type === 'calendar') return !!config.calendar;
  if (type === 'timeline') return !!config.timeline;
  return true;
}
