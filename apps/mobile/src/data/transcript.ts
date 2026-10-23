/**
 * A conversation's transcript on the phone. React-free (./transcript.test.ts). The server pages
 * messages newest first (`/api/sessions/:id/messages`, each page in transcript order with
 * `next_before_seq` for the page before it): the latest page opens the conversation, older pages
 * come in as the member scrolls up, and a reload after a reply merges into what is loaded instead
 * of replacing it — earlier history never disappears. A reply streamed on screen is replaced by
 * the saved transcript only once that transcript holds it (`holdsReplyAfter`).
 */

export interface TranscriptMessage {
  id: string;
  role: string;
  content: string;
  seq: number;
}

export interface MessagePage<M extends TranscriptMessage = TranscriptMessage> {
  messages: M[];
  has_more: boolean;
  next_before_seq: number | null;
}

export interface Transcript<M extends TranscriptMessage = TranscriptMessage> {
  /** Ascending by seq, one entry per seq. */
  messages: M[];
  /** The cursor for the page before the oldest loaded message, or null when all is loaded. */
  before: number | null;
}

function merged<M extends TranscriptMessage>(a: readonly M[], b: readonly M[]): M[] {
  const bySeq = new Map<number, M>();
  for (const message of [...a, ...b]) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

/**
 * The latest page merged into what is loaded: newer messages are added, saved versions replace the
 * same seq, and older history already loaded stays — so does the cursor to load even older.
 */
export function withLatest<M extends TranscriptMessage>(current: Transcript<M> | null, page: MessagePage<M>): Transcript<M> {
  if (!current) return { messages: merged([], page.messages), before: page.has_more ? page.next_before_seq : null };
  const newestLoaded = current.messages.at(-1)?.seq;
  // the page overlaps what is loaded (or is the whole conversation): no gap in between
  const reachesBack = !page.has_more || newestLoaded === undefined || (page.messages[0]?.seq ?? Infinity) <= newestLoaded;
  return {
    messages: merged(current.messages, page.messages),
    // a latest page that does not reach what is loaded leaves a gap: page back from its start (repeats merge away)
    before: reachesBack ? current.before : page.has_more ? page.next_before_seq : null,
  };
}

/** An older page put in front of what is loaded. */
export function withOlder<M extends TranscriptMessage>(current: Transcript<M>, page: MessagePage<M>): Transcript<M> {
  return { messages: merged(page.messages, current.messages), before: page.has_more ? page.next_before_seq : null };
}

/** The highest seq loaded, or -1. */
export function lastSeq(transcript: Transcript | null): number {
  return transcript?.messages.at(-1)?.seq ?? -1;
}

/**
 * Whether a saved page holds the reply to a message sent when the transcript ended at `sinceSeq`:
 * an assistant message after it. Until then the streamed reply stays on screen.
 */
export function holdsReplyAfter(page: MessagePage, sinceSeq: number): boolean {
  return page.messages.some((message) => message.role === 'assistant' && message.seq > sinceSeq);
}
