/**
 * The first message of a separate chat started from the new-chat page (spec
 * 20261011-agent-first-class §5a): that page creates the chat, then hands its
 * message over to the conversation view it opens, which sends it through the
 * one Bots send path — the pending bubble, the run stream, the failure notice
 * are all the conversation's own. Module scope (like composer drafts): the
 * hand-over crosses a route change, and it is taken exactly once.
 */

export interface FirstSend {
  /** What is sent: the text, plus the ```attachments fence when files went with it. */
  content: string;
  images: Array<{ id: string; url: string }>;
  /** Given back to the composer if the send fails (the text as typed, without the fence). */
  draft: string;
}

const waiting = new Map<string, FirstSend>();

export function queueFirstSend(sessionId: string, send: FirstSend): void {
  waiting.set(sessionId, send);
}

/** The message waiting for this conversation, removed as it is read (a second mount gets nothing). */
export function takeFirstSend(sessionId: string): FirstSend | null {
  const send = waiting.get(sessionId) ?? null;
  waiting.delete(sessionId);
  return send;
}
