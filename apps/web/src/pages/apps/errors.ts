import { ApiClientError } from '@greenhouse/contract/client';
import { errorText } from '../../lib/errors';
import type { Translate } from '../../lib/i18n';
export function appsError(error: unknown, t: Translate) {
  if (error instanceof ApiClientError) {
    if (error.code === 'stale_revision') return t('apps.error.stale');
    if (error.code === 'stale_version') return t('apps.error.version');
    if (error.code === 'invalid_input') return t('apps.error.invalid');
    if (error.code === 'template_unavailable' || error.code === 'template_invalid') return t('apps.error.template');
  }
  return errorText(error, t);
}
