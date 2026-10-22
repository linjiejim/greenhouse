/**
 * Live knowledge updates — `knowledge.changed` over the user WebSocket.
 *
 * Hangs off the knowledge service's change hook (`onKnowledgeDocChange`), the
 * one place every document write passes: the web editor, the chat
 * `knowledge_mutation` tool, MCP and an approved agent write all land there, so
 * no caller can forget to announce a change.
 *
 * Audience = who can see the document (knowledge/access.ts), before or after
 * the change: a team doc goes to every connected member (all sockets belong to
 * internal accounts); a private doc goes to its owner and the users it is
 * shared with, directly or through a group. The event carries ids only — the
 * receiver refetches through the authenticated API, which re-checks access.
 */

import type { DatabaseProvider, KnowledgeDocChange } from '@greenhouse/db';
import { onKnowledgeDocChange } from '@greenhouse/db';
import type { ServerWsEvent } from '@greenhouse/types/ws';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { connectionManager } from '../ws/connection-manager.js';

type Sender = Pick<typeof connectionManager, 'broadcast' | 'sendToUser'>;

/** Send one change to everyone who can see the document. */
export async function publishKnowledgeChange(
  db: Pick<DatabaseProvider, 'knowledgeShares'>,
  change: KnowledgeDocChange,
  sender: Sender = connectionManager,
): Promise<void> {
  const event: ServerWsEvent = { type: 'knowledge.changed', docId: change.doc.id, change: change.kind };
  if (change.doc.visibility === 'team' || change.previous?.visibility === 'team') {
    sender.broadcast(event);
    return;
  }
  const recipients = new Set<string>(await db.knowledgeShares.userIdsWithAccess(change.doc.id));
  for (const owner of [change.doc.owner_user_id, change.previous?.owner_user_id]) if (owner) recipients.add(owner);
  for (const userId of recipients) sender.sendToUser(userId, event);
}

/** Start announcing knowledge writes. Returns the unsubscribe function. */
export function startKnowledgeLiveUpdates(db: Pick<DatabaseProvider, 'knowledgeShares'>): () => void {
  return onKnowledgeDocChange((change) => {
    void publishKnowledgeChange(db, change).catch((error) =>
      logger.warn('[knowledge] live update failed', { docId: change.doc.id, error: toErrorMessage(error) }),
    );
  });
}
