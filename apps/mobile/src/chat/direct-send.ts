/**
 * What the conversation screen does after sending a message from its composer. React-free
 * (./direct-send.test.ts). The turn carries an id from the start; a send the station never
 * answered falls back into the outbox under that same id (so the station can tell a retry from a
 * new turn), refused words come back to the composer. All of it only while the member who sent
 * it is still the one signed in on that station: a late answer for someone else is dropped.
 */

import type { SendResult, SentImage } from '../data/conversation';
import type { QueuedTurn } from '../data/outbox';

export interface DirectSend {
  /** Sends the turn under `turnId` (Conversation.send). */
  send: (turnId: string) => Promise<SendResult>;
  /** Captured before the send (src/data/identity.ts). */
  stillCurrent: () => boolean;
  sessionId: string | null;
  text: string;
  images: readonly SentImage[];
  turnId: string;
}

export interface DirectSendEffects {
  /** Queue it (src/store/outbox.ts `queueTurn`); false when the outbox is full. */
  queue: (turn: Omit<QueuedTurn, 'createdAt'>) => boolean;
  setOffline: () => void;
  restoreDraft: (words: string) => void;
  alert: (why: 'full' | 'busy' | 'failed', message?: string) => void;
}

export async function sendDirect(turn: DirectSend, effects: DirectSendEffects): Promise<boolean> {
  const result = await turn.send(turn.turnId);
  if (result.sent) return true;
  // the station or member changed meanwhile: these words are not the new member's to queue or see
  if (!turn.stillCurrent()) return false;
  if (result.notice === 'offline') {
    effects.setOffline();
    // no answer: it may have arrived; the retry reuses the turn id, so the station saves it once
    if (turn.sessionId && effects.queue({ id: turn.turnId, sessionId: turn.sessionId, text: turn.text, images: [...turn.images], status: 'unknown' })) return false;
    effects.restoreDraft(result.restore);
    effects.alert('full');
    return false;
  }
  effects.restoreDraft(result.restore);
  effects.alert(result.notice === 'busy' ? 'busy' : 'failed', result.message || undefined);
  return false;
}
