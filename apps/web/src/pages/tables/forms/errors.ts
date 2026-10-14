import { ApiClientError } from '@greenhouse/contract/client';
import type { MessageKey } from '../../../i18n/zh';
import type { Translate } from '../../../lib/i18n';
import { tablesError } from '../errors';

const CODES: Record<string, MessageKey> = {
  form_closed: 'tables.forms.error.closed',
  already_submitted: 'tables.forms.error.already',
  too_many_forms: 'tables.forms.error.tooMany',
};

/** The words for a failed forms call: the forms' codes, then the tables' and the app's. */
export function formsError(error: unknown, t: Translate): string {
  if (error instanceof ApiClientError) {
    const key = CODES[error.code];
    if (key) return t(key);
  }
  return tablesError(error, t);
}
