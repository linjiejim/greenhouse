import type { ApiMiss } from './client';
import type { TFunction } from '../lib/i18n';

/** Switch errors have stable codes and details; server copy is not the member's language. */
export function operationErrorText(error: Pick<ApiMiss, 'code' | 'details'>, t: TFunction): string | undefined {
  if (error.code !== 'operation_disabled') return undefined;
  const operation = (error.details as { switch?: string } | undefined)?.switch;
  if (operation === 'disable_computers') return t('integration.computersDisabled');
  if (operation === 'pause_background_runs') return t('integration.backgroundPaused');
  if (operation === 'disable_outbound_mail') return t('integration.outboundMailDisabled');
  return t('integration.operationPaused');
}
