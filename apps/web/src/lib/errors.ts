import { ApiClientError } from '@greenhouse/contract/client';
import type { MessageKey } from '../i18n/zh';
import type { Translate } from './i18n';

/** Codes the member can act on get the dictionary's words; anything else shows the server's. */
const KNOWN: Record<string, MessageKey> = {
  agent_paused: 'errors.agentPaused',
  agent_unavailable: 'errors.agentUnavailable',
  agent_archived: 'errors.agentArchived',
  daily_cap_reached: 'errors.dailyCap',
  budget_exceeded: 'errors.budget',
  conversation_busy: 'errors.busy',
  read_only: 'errors.readOnly',
  not_latest: 'errors.notLatest',
  rate_limited: 'login.tooMany',
  too_large: 'errors.tooLarge',
  path_outside_home: 'errors.outsideHome',
  computer_not_running: 'errors.computerOff',
  upload_incomplete: 'errors.uploadCut',
  computers_full: 'errors.computersFull',
  model_unavailable: 'errors.modelUnavailable',
};

export function errorText(error: unknown, t: Translate): string {
  if (error instanceof ApiClientError) {
    const key = KNOWN[error.code];
    if (key) return t(key);
    if (error.status >= 500 || error.status === 0) return t('common.error');
    return error.message;
  }
  return t('login.offline');
}
