/**
 * How a card's group / series keys read and which colour slot they take.
 *
 * The aggregate returns raw keys — option ids, user ids, `YYYY-MM-DD` bucket
 * starts, JSON text for multi-values — so every card renderer goes through here
 * to turn them into labels. Colour slots follow the entity, not its rank: a
 * select option keeps its position in the field's option list, so filtering a
 * series away never repaints the others.
 */

import { useMemo } from 'react';
import type { TableCardSpec, TableDateBucket, TableSystemField } from '@greenhouse/types/tables';
import type { TableCardPoint } from '@greenhouse/types/table-cards';
import type { TableField } from '../../lib/api/tables';
import { useI18n, type AnyTranslationKey } from '../../lib/i18n';
import { fieldConfig, SYSTEM_FIELD_LABEL_KEYS } from '../tables/field-types';
import type { TableUsersById } from '../tables/field-value';

export type CardKey = TableCardPoint['group'];
export type CardDimension = { fieldId?: number; systemField?: TableSystemField; dateBucket?: TableDateBucket };
export type CardTranslate = (key: AnyTranslationKey, params?: Record<string, string | number>) => string;

export interface CardLabelContext {
  fieldsById: ReadonlyMap<number, TableField>;
  usersById: TableUsersById;
  t: CardTranslate;
  /** BCP 47 tag for number and date formatting. */
  locale: string;
}

function dayFormat(locale: string, options: Intl.DateTimeFormatOptions): (day: string) => string {
  // Bucket keys are calendar days, not instants: format them in UTC so no local
  // offset moves "2026-03-01" to the last day of February.
  const format = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
  return (day) => {
    const date = new Date(`${day}T00:00:00.000Z`);
    return Number.isNaN(date.valueOf()) ? day : format.format(date);
  };
}

function bucketOf(dim: CardDimension): TableDateBucket | undefined {
  if (dim.dateBucket) return dim.dateBucket;
  return dim.systemField === 'created_at' || dim.systemField === 'updated_at' ? 'day' : undefined;
}

function bucketLabel(bucket: TableDateBucket, key: string, ctx: CardLabelContext): string {
  const day = dayFormat(ctx.locale, { year: 'numeric', month: 'short', day: 'numeric' });
  switch (bucket) {
    case 'day':
      return day(key);
    case 'week':
      return ctx.t('tables.dashboard.card.weekOf', { date: day(key) });
    case 'month':
      return dayFormat(ctx.locale, { year: 'numeric', month: 'short' })(key);
    case 'quarter':
      return ctx.t('tables.dashboard.card.quarter', {
        year: key.slice(0, 4),
        quarter: Math.floor((Number(key.slice(5, 7)) - 1) / 3) + 1,
      });
    case 'year':
      return key.slice(0, 4);
  }
}

function arrayKey(key: string): unknown[] | null {
  if (!key.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(key) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The name of a dimension itself (the field, or the system column). */
export function dimensionTitle(dim: CardDimension | undefined, ctx: CardLabelContext): string {
  if (!dim) return '';
  if (dim.systemField) return ctx.t(SYSTEM_FIELD_LABEL_KEYS[dim.systemField]);
  return (dim.fieldId === undefined ? undefined : ctx.fieldsById.get(dim.fieldId)?.name) ?? '';
}

/** One group / series key as a person reads it. */
export function dimensionLabel(dim: CardDimension | undefined, key: CardKey, ctx: CardLabelContext): string {
  // An ungrouped card has one point standing for every record it counts.
  if (!dim) return ctx.t('tables.dashboard.allRecords');
  if (key === null || key === undefined || key === '') return ctx.t('tables.dashboard.card.empty');
  const text = String(key);
  const bucket = bucketOf(dim);
  if (bucket) return bucketLabel(bucket, text, ctx);
  if (dim.systemField) return ctx.usersById.get(text)?.nickname ?? text;
  const field = dim.fieldId === undefined ? undefined : ctx.fieldsById.get(dim.fieldId);
  if (!field) return text;
  const config = fieldConfig(field);
  const type = field.type === 'formula' ? (config.formula?.resultType ?? 'text') : field.type;
  const optionLabel = (id: unknown) => config.options?.find((option) => option.id === id)?.label ?? String(id);
  const userLabel = (id: unknown) => ctx.usersById.get(String(id))?.nickname ?? String(id);
  switch (type) {
    case 'single_select':
      return optionLabel(text);
    case 'multi_select':
      return (arrayKey(text) ?? [text]).map(optionLabel).join(', ');
    case 'user':
      return userLabel(text);
    case 'multi_user':
      return (arrayKey(text) ?? [text]).map(userLabel).join(', ');
    case 'boolean':
      return text === 'true' ? ctx.t('common.yes') : ctx.t('common.no');
    case 'date':
      return dayFormat(ctx.locale, { year: 'numeric', month: 'short', day: 'numeric' })(text);
    case 'datetime': {
      const date = new Date(text);
      return Number.isNaN(date.valueOf())
        ? text
        : date.toLocaleString(ctx.locale, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
    }
    case 'number':
    case 'rollup': {
      const value = Number(text);
      return Number.isFinite(value) ? formatCardNumber(value, ctx.locale) : text;
    }
    default:
      return text;
  }
}

/**
 * The colour slot of a key: a select option's position in its field, `true`
 * before `false`, otherwise the key's position among `keys` (sorted, so the
 * same set of keys always maps the same way).
 */
export function dimensionSlot(
  dim: CardDimension | undefined,
  key: CardKey,
  keys: readonly CardKey[],
  ctx: Pick<CardLabelContext, 'fieldsById'>,
): number {
  const field = dim?.fieldId === undefined ? undefined : ctx.fieldsById.get(dim.fieldId);
  if (field && (field.type === 'single_select' || field.type === 'multi_select') && key !== null) {
    const index = (fieldConfig(field).options ?? []).findIndex((option) => option.id === key);
    if (index >= 0) return index;
  }
  if (field?.type === 'boolean') return key === 'true' || key === true ? 0 : 1;
  const sorted = [...new Set(keys.map((entry) => (entry === null ? '\u0000' : String(entry))))].sort();
  return Math.max(0, sorted.indexOf(key === null ? '\u0000' : String(key)));
}

/** A number as a card shows it: grouping, at most two decimals. */
export function formatCardNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/** The card's group / series dimensions (undefined when it has none). */
export function cardDimensions(card: TableCardSpec): { group?: CardDimension; series?: CardDimension } {
  return { group: card.aggregate?.groupBy, series: card.aggregate?.series };
}

/** The label context for the cards of one table, in the current language. */
export function useCardLabels(fields: readonly TableField[], usersById: TableUsersById): CardLabelContext {
  const { t, locale } = useI18n();
  return useMemo(
    () => ({
      fieldsById: new Map(fields.map((field) => [field.id, field])),
      usersById,
      t,
      locale: locale === 'zh' ? 'zh-CN' : 'en-US',
    }),
    [fields, usersById, t, locale],
  );
}
