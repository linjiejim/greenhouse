/**
 * Single-writer inbox items — what any producer outside a running Bots turn
 * may hand to a conversation (docs/specs/20261005-personal-assistant-bots.md §4.1).
 *
 * `deliverToConversation(sessionId, item)` (bots/engine/inbox.ts) first tries to
 * claim the conversation's ChatRun slot: on success it writes/starts directly
 * and releases; otherwise it persists the item in `bot_inbox`, and the running
 * engine drains it between Bot turns (an idle sweeper catches stragglers).
 * Producers never append to a Bots transcript themselves.
 */

import type { BotEvent } from '@greenhouse/types/bots';

/**
 * The message id of a background task's report is `bot-task-report:<runId>` — one
 * report per task. The reply-alert sweep skips these: the task's own "done" push
 * already told the member.
 */
export const TASK_REPORT_MESSAGE_PREFIX = 'bot-task-report:';

export type InboxItem =
  /** A system line in the transcript (role `system`, `bot_event` set). */
  | { kind: 'event'; text: string; event: BotEvent; botId?: string | null }
  /** Wake a Bot to continue (after a hand-back, an approval, a created Bot joining…). */
  | {
      kind: 'continue';
      botId: string;
      note: string;
      exchangeId?: string;
      author_user_id?: string;
      eventText?: string;
      event?: BotEvent;
    }
  /** A background task finished: the Bot reports, then nothing else runs. */
  | {
      kind: 'task_report';
      botId: string;
      runId: string;
      title: string;
      status: 'succeeded' | 'failed' | 'canceled';
      /** ≤3000 chars, written by the task. */
      report: string;
    }
  /** A member message sent while the conversation was busy (202 queued) — in a room, every message. */
  | {
      kind: 'user_message';
      content: string;
      mentions: string[];
      directed?: boolean;
      images?: Array<{ id: string; url: string }>;
      /** In a room: who wrote it; their own run answers its @-mentions (P5). */
      author_user_id?: string;
    }
  /**
   * In a room: someone @-mentioned Agents while another person's run held the conversation. Their
   * message is already written; this answers it in a run of their own, after the current one (P5).
   */
  | { kind: 'mention'; author_user_id: string; mentions: string[]; directed?: boolean; messageId?: string };
