/**
 * A conversation's transcript on the phone. React-free (./transcript.test.ts). The server pages
 * messages newest first (`/api/sessions/:id/messages`, each page in transcript order with
 * `next_before_seq` for the page before it): the latest page opens the conversation, older pages
 * come in as the member scrolls up, and a reload after a reply merges into what is loaded instead
 * of replacing it — earlier history never disappears, while the latest page is authoritative for
 * its own range (`withLatest`). A reply streamed on screen is replaced by the saved transcript only
 * once that transcript holds it (`holdsNewReply`).
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
 * The latest page is authoritative for the range it covers: it replaces every loaded message from
 * its first seq on, so a message edited or a tail cut off on the web (edit and re-run) goes
 * away here too, while older history loaded before that range stays — and so does the cursor to
 * load even older. A page that is the whole conversation (`has_more` false) replaces everything.
 */
export function withLatest<M extends TranscriptMessage>(current: Transcript<M> | null, page: MessagePage<M>): Transcript<M> {
  const fresh = merged([], page.messages);
  const cursor = page.has_more ? page.next_before_seq : null;
  if (!current || !page.has_more) return { messages: fresh, before: cursor };
  const first = fresh[0]?.seq ?? Infinity;
  const older = current.messages.filter((message) => message.seq < first);
  // the page overlaps what is loaded and older history sits right before it: keep paging from there;
  // otherwise page back from the page's own start (a gap, or nothing older loaded yet)
  const overlaps = current.messages.some((message) => message.seq >= first);
  return { messages: [...older, ...fresh], before: overlaps && older.length ? current.before : cursor };
}

/** An older page put in front of what is loaded. */
export function withOlder<M extends TranscriptMessage>(current: Transcript<M>, page: MessagePage<M>): Transcript<M> {
  return { messages: merged(page.messages, current.messages), before: page.has_more ? page.next_before_seq : null };
}

/** The ids of the messages loaded, to recognise a reply among them later. */
export function knownIds(transcript: Transcript | null): Set<string> {
  return new Set((transcript?.messages ?? []).map((message) => message.id));
}

/**
 * Whether a saved page holds the reply to a message sent when the transcript held `known`: an
 * assistant message that was not there — after the last one, or in place of one (same seq, new
 * id, when the conversation was edited and re-run). Until then the streamed reply stays on screen.
 */
export function holdsNewReply(page: MessagePage, known: ReadonlySet<string>): boolean {
  return page.messages.some((message) => message.role === 'assistant' && !known.has(message.id));
}
