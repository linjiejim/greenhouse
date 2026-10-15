import { ApiClientError } from '@greenhouse/contract/client';
import type { MessageKey } from '../i18n/zh';
import type { Translate } from './i18n';

/** Codes the member can act on get the dictionary's words; anything else shows the server's. */
const KNOWN: Record<string, MessageKey> = {
  undo_conflict: 'errors.undoConflict',
  already_undone: 'errors.alreadyUndone',
  undo_unavailable: 'errors.undoUnavailable',
  standing_not_allowed: 'errors.standingNotAllowed',
  request_building: 'errors.requestBuilding',
  computer_background_busy: 'errors.computerBackgroundBusy',
  background_network_unavailable: 'errors.backgroundNetworkUnavailable',

  agent_paused: 'errors.agentPaused',
  agent_unavailable: 'errors.agentUnavailable',
  agent_archived: 'errors.agentArchived',
  daily_cap_reached: 'errors.dailyCap',
  operation_disabled: 'errors.operationDisabled',
  budget_exceeded: 'errors.budget',
  conversation_busy: 'errors.busy',
  read_only: 'errors.readOnly',
  not_latest: 'errors.notLatest',
  rate_limited: 'login.tooMany',
  too_large: 'errors.tooLarge',
  audio_too_large: 'errors.audioTooLarge',
  audio_too_long: 'errors.audioTooLong',
  stt_not_configured: 'errors.sttUnavailable',
  tts_not_configured: 'errors.ttsUnavailable',
  provider_failed: 'errors.providerFailed',
  path_outside_home: 'errors.outsideHome',
  computer_not_running: 'errors.computerOff',
  upload_incomplete: 'errors.uploadCut',
  model_unavailable: 'errors.modelUnavailable',
  connector_disabled: 'errors.connectorOff',
  connection_busy: 'errors.connectionBusy',
  registry_unavailable: 'errors.registry',
  too_many_tokens: 'errors.tooManyTokens',
  // The knowledge base's rules for moving, sharing and archived items.
  folder_too_deep: 'errors.folderTooDeep',
  folder_cycle: 'errors.folderCycle',
  agent_folder: 'errors.agentFolder',
  agent_folder_private: 'errors.agentFolderPrivate',
  cross_space_move: 'errors.crossSpaceMove',
  doc_file: 'errors.docFile',
  archived: 'errors.archived',
  team_space: 'errors.teamSpace',
};

export function errorText(error: unknown, t: Translate): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'operation_disabled') {
      const operation = (error.details as { switch?: string } | undefined)?.switch;
      if (operation === 'disable_computers') return t('errors.computersDisabled');
      if (operation === 'pause_background_runs') return t('errors.backgroundPaused');
      if (operation === 'disable_outbound_mail') return t('errors.outboundMailDisabled');
    }
    const key = KNOWN[error.code];
    if (key) return t(key);
    if (error.status >= 500 || error.status === 0) return t('common.error');
    return error.message;
  }
  return t('login.offline');
}
