/**
 * Where a session hit of the global search opens: an ordinary chat in the chat engine, an Agent
 * conversation (a separate Agent chat, `channel: 'bots'`) in its own view — spec
 * 20261011-agent-first-class D21.
 */

import type { SessionSearchHit } from '@greenhouse/types/search';
import { botsConversationHash } from '../bots/navigation';

export function sessionHitHash(hit: Pick<SessionSearchHit, 'sessionId' | 'channel'>): string {
  return hit.channel === 'bots'
    ? botsConversationHash(hit.sessionId)
    : `#/chat?session=${encodeURIComponent(hit.sessionId)}`;
}
