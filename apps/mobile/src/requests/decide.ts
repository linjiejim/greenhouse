/**
 * Deciding a 「需要你」 card (`/api/requests/:id/…`), with one rule per outcome: a decision that
 * went through gets the success haptic and the card flips to what happened (the thread store
 * and the notification badge follow); one settled elsewhere (409 — another phone, the web, it
 * expired) is quiet — the card is read again and shows what happened; one the server could not
 * carry out keeps the card pending and says why in a system alert.
 */

import { operationErrorText } from '../api/operation-error';
import { captureIdentity } from '../data/identity';
import { answerRequest, approveRequest, handBack, rejectRequest } from '../api/requests';
import type { ApiResult } from '../api/client';
import { t } from '../lib/i18n';
import type { NeedsYou } from '../shared/contract';
import { useThreads } from '../store/threads';
import { useWorkspace } from '../store/workspace';
import { alertError } from '../ui/dialogs';
import { notifySuccess } from '../ui/haptics';

export type Decision =
  | { action: 'approve'; standing?: boolean; continueAfter?: boolean }
  | { action: 'reject'; reason?: string }
  | { action: 'answer'; answers: Record<string, string> }
  | { action: 'handBack'; note?: string };

export type DecideOutcome = 'done' | 'stale' | 'failed';

export async function decide(request: NeedsYou, decision: Decision): Promise<DecideOutcome> {
  const current = captureIdentity();
  let result: ApiResult<NeedsYou>;
  switch (decision.action) {
    case 'approve':
      result = await approveRequest(request.id, decision.standing, decision.continueAfter);
      break;
    case 'reject':
      result = await rejectRequest(request.id, decision.reason);
      break;
    case 'answer':
      result = await answerRequest(request.id, decision.answers);
      break;
    case 'handBack':
      result = await handBack(request.id, decision.note);
      break;
  }
  if (!current()) return 'stale';
  const conversation = request.conversation_id;
  const settle = () => {
    void useWorkspace.getState().refreshSummary();
    if (conversation) void useThreads.getState().refreshRequests(conversation);
  };
  if (result.ok) {
    if (conversation) useThreads.getState().putRequests(conversation, [result.data]);
    notifySuccess();
    settle();
    return 'done';
  }
  settle();
  if (result.status === 409) return 'stale';
  alertError(
    t('requests.failed'),
    operationErrorText(result, t),
    operationErrorText(result, t) ? undefined : result.message,
  );
  return 'failed';
}
