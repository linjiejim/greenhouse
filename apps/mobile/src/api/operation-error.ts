import type { ApiMiss } from './client';
import type { TFunction } from '../lib/i18n';

/** Rule refusals use stable codes; server copy may be in another language. */
export function operationErrorText(error: Pick<ApiMiss, 'code' | 'details'>, t: TFunction): string | undefined {
  if (error.code === 'memory_background_read_only') return t('integration.memoryBackgroundReadOnly');
  if (error.code === 'memory_untrusted_content') return t('integration.memoryUntrustedContent');
  if (error.code !== 'operation_disabled') return undefined;
  const operation = (error.details as { switch?: string } | undefined)?.switch;
  if (operation === 'disable_computers') return t('integration.computersDisabled');
  if (operation === 'pause_background_runs') return t('integration.backgroundPaused');
  if (operation === 'disable_outbound_mail') return t('integration.outboundMailDisabled');
  return t('integration.operationPaused');
}
