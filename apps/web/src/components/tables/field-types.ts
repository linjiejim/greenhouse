/**
 * Field-type vocabulary shared by every Tables surface: type labels, system
 * column labels, and which types a builder may create from the field dialog.
 */

import {
  TABLE_FIELD_TYPES,
  isComputedFieldType,
  type TableFieldConfig,
  type TableFieldType,
  type TableSystemField,
} from '@greenhouse/types/tables';
import type { TableField } from '../../lib/api/tables';
import type { TranslationKey } from '../../lib/i18n';
import { safeParse } from '../../lib/utils';

export const FIELD_TYPE_LABEL_KEYS: Record<TableFieldType, TranslationKey> = {
  text: 'tables.fieldType.text',
  long_text: 'tables.fieldType.longText',
  number: 'tables.fieldType.number',
  boolean: 'tables.fieldType.boolean',
  date: 'tables.fieldType.date',
  datetime: 'tables.fieldType.datetime',
  single_select: 'tables.fieldType.singleSelect',
  multi_select: 'tables.fieldType.multiSelect',
  user: 'tables.fieldType.user',
  multi_user: 'tables.fieldType.multiUser',
  url: 'tables.fieldType.url',
  email: 'tables.fieldType.email',
  phone: 'tables.fieldType.phone',
  attachment: 'tables.fieldType.attachment',
  relation: 'tables.fieldType.relation',
  formula: 'tables.fieldType.formula',
  rollup: 'tables.fieldType.rollup',
  lookup: 'tables.fieldType.lookup',
  ai: 'tables.fieldType.ai',
};

/** The columns every record carries, labelled like the record drawer's metadata block. */
export const SYSTEM_FIELD_LABEL_KEYS: Record<TableSystemField, TranslationKey> = {
  created_by: 'tables.createdBy',
  created_at: 'tables.created',
  updated_at: 'tables.updated',
  updated_by: 'tables.updatedBy',
};

/**
 * Types the field dialog offers: every type that has a configuration there.
 * AI field creation additionally requires the user feature.
 */
export const CREATABLE_FIELD_TYPES: readonly TableFieldType[] = TABLE_FIELD_TYPES;

/** Derived, never written: formula / rollup / lookup / ai (one list, `COMPUTED_FIELD_TYPES`). */
export function isComputedField(field: Pick<TableField, 'type'>): boolean {
  return isComputedFieldType(field.type);
}

export function fieldConfig(field: Pick<TableField, 'config'>): TableFieldConfig {
  return safeParse<TableFieldConfig>(field.config, {});
}
