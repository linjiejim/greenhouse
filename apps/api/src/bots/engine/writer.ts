/**
 * The single writer of a Bots transcript (spec §4.1, design review R4/R5).
 *
 * Whoever holds a conversation's ChatRun slot owns its tail. Every row the
 * engine writes — hand-off lines, system events, Bot replies, task reports,
 * queued member messages — goes through one writer per run, which:
 * - appends server rows with `appendIfTail` (compare-and-set on the last row),
 *   so a foreign write is detected instead of silently interleaved;
 * - serializes its own appends (parallel tool calls in one step may each
 *   raise a card), so they never race each other for the tail;
 * - advances the tail after every write, which is what lets several Bot
 *   turns land in one run.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type { BotEvent } from '@greenhouse/types/bots';
import type { MessageRow } from '@greenhouse/types/session';

export class TranscriptChangedError extends Error {
  constructor(readonly sessionId: string) {
    super('The Bots transcript changed under its single writer');
    this.name = 'TranscriptChangedError';
  }
}

export interface Tail {
  id: string;
  content: string;
}

export class TranscriptWriter {
  private chain: Promise<unknown> = Promise.resolve();
  private current: Tail | null;
  private currentSeq: number;

  constructor(
    private readonly db: DatabaseProvider,
    readonly sessionId: string,
    tail: Pick<MessageRow, 'id' | 'content' | 'seq'> | null,
  ) {
    this.current = tail ? { id: tail.id, content: tail.content } : null;
    this.currentSeq = tail?.seq ?? -1;
  }

  /** The current expected tail (null for an empty transcript). */
  get tail(): Tail | null {
    return this.current;
  }

  get tailSeq(): number {
    return this.currentSeq;
  }

  /**
   * Move the tail after a write made under the same slot (persistChatResult,
   * an idempotent re-append). An idempotency hit can return an OLDER row —
   * the tail never moves backwards.
   */
  advance(row: Pick<MessageRow, 'id' | 'content' | 'seq'>): void {
    if (row.seq < this.currentSeq) return;
    this.current = { id: row.id, content: row.content };
    this.currentSeq = row.seq;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** A system line (role `system`) with its structured event. */
  appendEvent(input: {
    text: string;
    event: BotEvent;
    botId?: string | null;
    messageId?: string;
  }): Promise<MessageRow> {
    return this.appendServerRow({
      role: 'system',
      content: input.text,
      bot_event: input.event,
      botId: input.botId ?? null,
      messageId: input.messageId,
    });
  }

  /** A Bot-authored row the engine writes itself (task report, greeting). */
  appendBotRow(input: { botId: string; content: string; event: BotEvent; messageId?: string }): Promise<MessageRow> {
    return this.appendServerRow({
      role: 'assistant',
      content: input.content,
      bot_event: input.event,
      botId: input.botId,
      messageId: input.messageId,
    });
  }

  private appendServerRow(input: {
    role: 'system' | 'assistant';
    content: string;
    bot_event: BotEvent;
    botId: string | null;
    messageId?: string;
  }): Promise<MessageRow> {
    return this.serialize(async () => {
      const message = {
        session_id: this.sessionId,
        role: input.role,
        content: input.content,
        bot_event: JSON.stringify(input.bot_event),
        ...(input.botId ? { bot_id: input.botId } : {}),
      };
      if (!this.current) {
        // Only an empty transcript has no tail; the slot holder is the only writer.
        const row = input.messageId
          ? await this.db.sessions.addMessageOnce(input.messageId, message)
          : await this.db.sessions.addMessage(message);
        this.advance(row);
        return row;
      }
      const result = await this.db.sessions.appendIfTail(this.sessionId, this.current, message, input.messageId);
      if (!result.ok) throw new TranscriptChangedError(this.sessionId);
      this.advance(result.message);
      return result.message;
    });
  }

  /**
   * A member message delivered from the inbox (role `user` cannot use
   * appendIfTail). With a `messageId` the append is idempotent, so a drain
   * that crashed after writing but before consuming the inbox row does not
   * write the message twice.
   */
  appendUser(input: {
    content: string;
    images?: Array<{ id: string; url: string }>;
    messageId?: string;
  }): Promise<MessageRow> {
    return this.serialize(async () => {
      const message = {
        session_id: this.sessionId,
        role: 'user' as const,
        content: input.content,
        ...(input.images?.length ? { images: input.images } : {}),
      };
      const row = input.messageId
        ? await this.db.sessions.addMessageOnce(input.messageId, message)
        : await this.db.sessions.addMessage(message);
      this.advance(row);
      return row;
    });
  }

  /** Wait for queued appends (before persisting a turn on the same tail). */
  async settled(): Promise<void> {
    await this.chain;
  }
}
