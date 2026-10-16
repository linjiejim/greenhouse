import { ApiClientError } from '@greenhouse/contract/client';
import { CellParseError } from '@greenhouse/contract';
import type { MessageKey } from '../../i18n/zh';
import { errorText } from '../../lib/errors';
import type { Translate } from '../../lib/i18n';

const CODES: Record<string, MessageKey> = {
  automation_webhook_invalid: 'tables.automation.invalidWebhook',
  automation_recipient_unavailable: 'tables.automation.recipientUnavailable',
  invalid_prompt: 'tables.computed.invalidPrompt',
  invalid_formula: 'tables.error.invalid_formula',
  computed_field: 'tables.error.computed_field',
  field_cycle: 'tables.error.field_cycle',
  no_model: 'tables.error.no_model',
  ai_unavailable: 'tables.error.no_model',
  too_many_roles: 'tables.error.too_many_roles',
  name_taken: 'tables.error.name_taken',
  stale_revision: 'tables.error.stale_revision',
  stale_schema: 'tables.error.stale_revision',
  link_cycle: 'tables.error.link_cycle',
  one_per_table: 'tables.error.one_per_table',
  view_needs_field: 'tables.error.view_needs_field',
  last_view: 'tables.error.last_view',
  type_change_unsupported: 'tables.error.type_change_unsupported',
  table_archived: 'tables.error.table_archived',
  primary_field: 'tables.error.primary_field',
  too_many_fields: 'tables.error.too_many_fields',
  too_many_tables: 'tables.error.too_many_tables',
  forbidden: 'tables.error.forbidden',
};

/** The words for a failed tables call: the module's codes first, then the app's. */
export function tablesError(error: unknown, t: Translate): string {
  if (error instanceof ApiClientError) {
    const key = CODES[error.code];
    if (key) return t(key);
  }
  if (error instanceof CellParseError) return t(`tables.paste.${error.reason}`, { text: error.text });
  return errorText(error, t);
}
