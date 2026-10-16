/** The words of an import: its status with its tone, why a row was skipped, why a call failed. */

import type { Tone } from '@greenhouse/ui/kit';
import { ApiClientError } from '@greenhouse/contract/client';
import type { BaseImport, ImportRowError } from '@greenhouse/contract';
import type { MessageKey } from '../../../i18n/zh';
import type { Locale, Translate } from '../../../lib/i18n';
import { tablesError } from '../errors';

/** Status words and tones of docs/design-system/content.md: running is info, failure danger. */
export function statusOf(item: Pick<BaseImport, 'status' | 'expires_at'>): { key: MessageKey; tone: Tone } {
  switch (item.status) {
    case 'draft':
      return item.expires_at && Date.parse(item.expires_at) <= Date.now()
        ? { key: 'tables.import.status.expired', tone: 'neutral' }
        : { key: 'tables.import.status.draft', tone: 'neutral' };
    case 'queued':
    case 'running':
      return { key: `tables.import.status.${item.status}`, tone: 'info' };
    case 'done':
      return { key: 'tables.import.status.done', tone: 'success' };
    case 'failed':
      return { key: 'tables.import.status.failed', tone: 'danger' };
    case 'cancelled':
      return { key: 'tables.import.status.cancelled', tone: 'neutral' };
  }
}

export function rowReason(error: ImportRowError, t: Translate): string {
  if (error.reason === 'invalid' && !error.text) return t('tables.import.reason.invalidRow');
  return t(`tables.import.reason.${error.reason}`, { text: error.text });
}

/** Codes an import call answers with; `details.row` names the row of the file. */
const CODES: Record<string, MessageKey> = {
  not_csv: 'tables.import.error.not_csv',
  not_utf8: 'tables.import.error.not_utf8',
  empty_file: 'tables.import.error.empty_file',
  too_large: 'tables.import.error.too_large',
  too_many_rows: 'tables.import.error.too_many_rows',
  too_many_columns: 'tables.import.error.too_many_columns',
  cell_too_long: 'tables.import.error.cell_too_long',
  row_too_long: 'tables.import.error.row_too_long',
  unclosed_quote: 'tables.import.error.unclosed_quote',
  import_expired: 'tables.import.error.import_expired',
  import_started: 'tables.import.error.import_started',
  import_finished: 'tables.import.error.import_finished',
  fields_changed: 'tables.import.error.fields_changed',
  nothing_mapped: 'tables.import.error.nothing_mapped',
  not_found: 'tables.import.error.not_found',
};

/** Names in a sentence: 「数量、日期」 or "Count, Date". */
export const nameList = (names: readonly string[], locale: Locale) => names.join(locale === 'zh' ? '、' : ', ');

export function importError(error: unknown, t: Translate, locale: Locale): string {
  if (error instanceof ApiClientError) {
    const details = (error.details ?? {}) as { row?: unknown; fields?: unknown };
    if (error.code === 'required_unmapped') {
      const fields = Array.isArray(details.fields) ? details.fields.map(String) : [];
      return t('tables.import.requiredMissing', { fields: nameList(fields, locale) });
    }
    const key = CODES[error.code];
    if (key) return t(key, { row: typeof details.row === 'number' ? details.row : '' });
  }
  return tablesError(error, t);
}

export const count = (value: number, locale: Locale) => value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US');
