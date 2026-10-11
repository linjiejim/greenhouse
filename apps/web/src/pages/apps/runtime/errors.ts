/**
 * What the runtime tells a viewer when a gateway write is refused: the
 * `details.reason` of `/actions` (`AppActionRefusal`) in their words, a 409 /
 * 403 / 404 without a reason by its status, a validation failure (400) by the
 * server's own message (it names the field), anything else by the fallback.
 */

import type { AppActionRefusal } from '@greenhouse/types/apps';
import { appActionRefusal } from '../../../lib/api/apps';
import { TablesRequestError } from '../../../lib/api/tables';
import type { TranslationKey } from '../../../lib/i18n';

const REFUSAL_KEYS: Record<AppActionRefusal, TranslationKey> = {
  precondition: 'apps.runtime.refusal.precondition',
  conflict: 'apps.runtime.refusal.conflict',
  required_input: 'apps.runtime.refusal.required_input',
  not_allowed: 'apps.runtime.refusal.not_allowed',
  not_found: 'apps.runtime.refusal.not_found',
};

export function describeAppError(
  t: (key: TranslationKey) => string,
  error: unknown,
  fallback: TranslationKey = 'apps.runtime.actions.failed',
): string {
  const reason = appActionRefusal(error);
  if (reason && Object.hasOwn(REFUSAL_KEYS, reason)) return t(REFUSAL_KEYS[reason as AppActionRefusal]);
  if (error instanceof TablesRequestError) {
    if (error.status === 409) return t(REFUSAL_KEYS.conflict);
    if (error.status === 403) return t(REFUSAL_KEYS.not_allowed);
    if (error.status === 404) return t(REFUSAL_KEYS.not_found);
    if (error.status === 400 && error.message) return error.message;
  }
  return t(fallback);
}
