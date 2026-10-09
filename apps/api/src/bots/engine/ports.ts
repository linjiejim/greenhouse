/**
 * What the conversation-level Bot tools (team, conversation, bot_tasks) need
 * from the running chain, beyond the generic BotTurnContext.
 *
 * The floor controller and the transcript writer belong to one run; the tools
 * get narrow callbacks instead of the run itself, so a tool can never append
 * to the transcript or reorder the floor except through these rules.
 */

import type { BotRow } from '@greenhouse/db';
import type { BotMemberRole } from '@greenhouse/types/bots';
import type { AskRejection } from './floor.js';

export interface TeamMember {
  bot: BotRow;
  role: BotMemberRole;
}

export interface TeamPort {
  /** Current members (live: reflects Bots added during this chain). */
  members(): TeamMember[];
  /** The member's other active Bots, not in this conversation. */
  others(): BotRow[];
  checkAsk(toBotId: string): AskRejection | null;
  /** Persist the hand-off line, queue the target, end the asker's turn after this step. */
  acceptAsk(toBotId: string, message: string): Promise<void>;
  /** Invite one of the member's existing Bots into this DM as a guest. */
  addMember(botId: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface ConversationPort {
  /** Messages at or below this seq are outside the Bot's context — what recall searches. */
  recallMaxSeq(): number;
  /** Names for speaker labels in recall results. */
  botName(botId: string | null): string | null;
  nickname: string;
}
