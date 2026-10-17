import { ApiClientError } from '@greenhouse/contract/client';
import type { MessageKey } from '../i18n/zh';
import type { Translate } from './i18n';

/** Stable codes and HTTP causes use the member’s language; unexpected server text stays private. */
const KNOWN: Record<string, MessageKey> = {
  sign_in_failed: 'errors.connectionSignIn',
  forbidden: 'errors.permission',
  not_found: 'errors.missing',
  invalid_input: 'errors.invalidInput',
  file_limit: 'errors.fileLimit',
  file_too_large: 'errors.fileTooLarge',
  memory_background_read_only: 'errors.memoryBackgroundReadOnly',
  memory_untrusted_content: 'errors.memoryUntrustedContent',
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
  fork_reply_unavailable: 'errors.forkReplyUnavailable',
  fork_source_unsupported: 'errors.forkSourceUnsupported',
  fork_agent_unavailable: 'errors.forkAgentUnavailable',
  fork_too_large: 'errors.forkTooLarge',
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

export function errorCodeText(code: string, t: Translate): string | undefined {
  const key = KNOWN[code];
  return key ? t(key) : undefined;
}

export function errorText(error: unknown, t: Translate): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'operation_disabled') {
      const operation = (error.details as { switch?: string } | undefined)?.switch;
      if (operation === 'disable_computers') return t('errors.computersDisabled');
      if (operation === 'pause_background_runs') return t('errors.backgroundPaused');
      if (operation === 'disable_outbound_mail') return t('errors.outboundMailDisabled');
    }
    const known = errorCodeText(error.code, t);
    if (known) return known;
    if (error.status === 401) return t('errors.sessionExpired');
    if (error.status === 403) return t('errors.permission');
    if (error.status === 404 || error.status === 410) return t('errors.missing');
    if (error.status === 408 || error.status === 504) return t('errors.requestTimeout');
    if (error.status === 409) return t('errors.conflict');
    if (error.status === 413) return t('errors.fileTooLarge');
    if (error.status === 429) return t('login.tooMany');
    if (error.status >= 500) return t('errors.temporarilyUnavailable');
    if (error.status === 0) return t('login.offline');
    return t('errors.invalidInput');
  }
  return t('login.offline');
}
