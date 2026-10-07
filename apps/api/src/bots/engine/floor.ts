/**
 * Floor controller — who speaks next in a Bots chain (pure, no I/O).
 *
 * One member message starts one chain: a sequence of Bot turns inside a single
 * ChatRun. The rules (spec §4.2, design review R13):
 * - owners = the addressees of the message (mentions in order, else the DM's
 *   owner Bot, else the group's lead), queued in order;
 * - depth-first: when a turn ends, the hand-offs it made (`team.ask`) jump to
 *   the FRONT of the queue in the order they were made, so an answer is never
 *   left hanging behind someone else's summary;
 * - an owner that handed work off gets exactly ONE reserved follow-up, placed
 *   after its whole ask subtree, and nothing can squeeze it out; other askers
 *   get none (their answer is visible to the owner anyway);
 * - an ask is refused (as a tool result, not an error) for: Bot chat switched
 *   off, asking yourself or a non-member, asking a Bot already up the asker
 *   chain (cycle / ping-pong), asking the same Bot twice in one chain, asking
 *   a Bot that was itself addressed and has not spoken yet (it answers after
 *   you anyway — handing it work would make it speak twice), more than 4 asks,
 *   depth ≥ 3, once any chain budget ran out (only reserved follow-ups still
 *   run, and they may not start new work), or when the turn budget could not
 *   fit the answer plus the owner's follow-up.
 *
 * Token, step and wall-clock budgets live in the chain (they need usage
 * numbers); this class only knows turns, asks and depth.
 */

import type { BotTurnReason } from '@greenhouse/types/bots';

export const CHAIN_LIMITS = {
  /** Bot turns per chain (one member message). */
  turns: 8,
  /** Accepted hand-offs per chain. */
  asks: 4,
  /** Owner = depth 0; an ask may create depth 1 and 2, never 3. */
  depth: 3,
  /** Provider input tokens per chain, cached input weighted ×0.25. */
  inputTokens: 600_000,
  cachedInputWeight: 0.25,
  outputTokens: 30_000,
  /** Model steps per chain across all turns. */
  steps: 60,
  wallClockMs: 20 * 60_000,
  /** Bot turns per run, across interjection-started chains. */
  runTurns: 16,
} as const;

/** Model steps a single turn may take, by why the Bot is speaking. */
export const STEP_CAPS: Record<BotTurnReason, number> = {
  user: 30,
  mention: 30,
  interjection: 30,
  continue: 30,
  ask: 12,
  followup: 4,
};

export interface FloorItem {
  botId: string;
  reason: BotTurnReason;
  /** The Bot that handed this work over (reason `ask`). */
  askedBy?: string;
  /** Ask content, or the note of a `continue`. */
  message?: string;
  /** Bots above this one in the hand-off chain, root first. */
  askerChain: string[];
  depth: number;
  /** An original addressee of the member's message. */
  owner: boolean;
  /** Follow-up only: the Bots this owner handed work to. */
  askedBots?: string[];
}

export type AskRejection =
  | 'bot_chat_off'
  | 'self'
  | 'not_member'
  | 'cycle'
  | 'repeat'
  | 'queued'
  | 'asks'
  | 'depth'
  | 'turns'
  | 'budget';

export interface FloorOptions {
  /** Live member set (the run refreshes it in place between turns). */
  members: ReadonlySet<string>;
  /** Read on every ask: the member can switch Bot-to-Bot chat off mid-run. */
  allowBotChat: () => boolean;
  /** Turns this chain may still take (≤ CHAIN_LIMITS.turns, less when the run is near its cap). */
  turnBudget?: number;
}

export class FloorController {
  private queue: FloorItem[] = [];
  private readonly askedThisChain = new Set<string>();
  private readonly followupReserved = new Set<string>();
  private pendingAsks: FloorItem[] = [];
  private current: FloorItem | null = null;
  private readonly turnBudget: number;
  /** A chain budget ran out: nothing new may start, only reserved follow-ups run. */
  private limited = false;
  turnsUsed = 0;
  asksUsed = 0;

  constructor(private readonly opts: FloorOptions) {
    this.turnBudget = Math.min(opts.turnBudget ?? CHAIN_LIMITS.turns, CHAIN_LIMITS.turns);
  }

  /** Queue the owners of a new chain. Unknown ids are dropped; duplicates keep their first position. */
  start(owners: Array<{ botId: string; reason: BotTurnReason; message?: string }>): void {
    const seen = new Set<string>();
    for (const owner of owners) {
      if (!this.opts.members.has(owner.botId) || seen.has(owner.botId)) continue;
      seen.add(owner.botId);
      this.queue.push({
        botId: owner.botId,
        reason: owner.reason,
        ...(owner.message ? { message: owner.message } : {}),
        askerChain: [],
        depth: 0,
        owner: true,
      });
    }
  }

  /** Append a server-initiated `continue` (after a hand-back, a created Bot joining…). */
  addContinue(botId: string, note: string): void {
    if (!this.opts.members.has(botId)) return;
    this.queue.push({ botId, reason: 'continue', message: note, askerChain: [], depth: 0, owner: true });
  }

  /**
   * Take the next turn, or null when the chain is done. A reserved follow-up
   * always runs; anything else needs turn budget (returns `'turns'` when the
   * budget ran out with work still queued, so the chain can say so).
   */
  next(): FloorItem | 'turns' | null {
    const item = this.queue.shift();
    if (!item) return null;
    if (this.turnsUsed >= this.turnBudget && item.reason !== 'followup') {
      this.limited = true;
      this.queue = this.queue.filter((queued) => queued.reason === 'followup');
      return 'turns';
    }
    this.turnsUsed += 1;
    this.current = item;
    this.pendingAsks = [];
    return item;
  }

  /** Validate a hand-off from the current speaker. Returns null when it would be accepted. */
  checkAsk(toBotId: string): AskRejection | null {
    const from = this.current;
    if (!from) return 'not_member';
    if (!this.opts.allowBotChat()) return 'bot_chat_off';
    if (toBotId === from.botId) return 'self';
    if (!this.opts.members.has(toBotId)) return 'not_member';
    // A reserved follow-up after a budget hit must wrap up, not start new work.
    if (this.limited) return 'budget';
    if (from.askerChain.includes(toBotId)) return 'cycle';
    if (this.askedThisChain.has(toBotId)) return 'repeat';
    // Also addressed by the member and still waiting for its own turn: it will
    // answer after this one anyway, so a hand-off would make it speak twice
    // (once for the asker, once more after the asker's wrap-up).
    if (this.queue.some((queued) => queued.owner && queued.reason !== 'followup' && queued.botId === toBotId)) {
      return 'queued';
    }
    if (this.asksUsed >= CHAIN_LIMITS.asks) return 'asks';
    if (from.depth + 1 >= CHAIN_LIMITS.depth) return 'depth';
    // The owner's follow-up is reserved when its turn ends with any accepted
    // ask, so it is already committed budget from the first ask on.
    const followup = from.owner && !this.followupReserved.has(from.botId) ? 1 : 0;
    const committed = this.turnsUsed + this.queue.length + this.pendingAsks.length + followup;
    if (committed + 1 > this.turnBudget) return 'turns';
    return null;
  }

  /** Record an accepted hand-off (call only after `checkAsk` returned null). */
  acceptAsk(toBotId: string, message: string): void {
    const from = this.current;
    // Defence in depth: after a budget hit no new turn may be queued, even if
    // a caller skipped `checkAsk`.
    if (!from || this.limited) return;
    this.askedThisChain.add(toBotId);
    this.asksUsed += 1;
    this.pendingAsks.push({
      botId: toBotId,
      reason: 'ask',
      askedBy: from.botId,
      message,
      askerChain: [...from.askerChain, from.botId],
      depth: from.depth + 1,
      owner: false,
    });
  }

  /**
   * Close the current turn: its accepted hand-offs go to the front (depth
   * first), then — once per owner — the owner's reserved follow-up.
   */
  endTurn(): void {
    const from = this.current;
    this.current = null;
    if (!from) return;
    const front: FloorItem[] = [...this.pendingAsks];
    if (this.pendingAsks.length > 0 && from.owner && !this.followupReserved.has(from.botId)) {
      this.followupReserved.add(from.botId);
      front.push({
        botId: from.botId,
        reason: 'followup',
        askerChain: [],
        depth: from.depth,
        owner: true,
        askedBots: this.pendingAsks.map((ask) => ask.botId),
      });
    }
    this.pendingAsks = [];
    this.queue = [...front, ...this.queue];
  }

  /** A chain budget ran out: only reserved follow-ups still get their turn. */
  hitLimit(): void {
    this.limited = true;
    this.pendingAsks = [];
    this.queue = this.queue.filter((item) => item.reason === 'followup');
  }

  /**
   * Stop / interjection: nothing queued survives (follow-ups included).
   * Returns the server-initiated `continue` wake-ups that never ran (a
   * hand-back, a created Bot joining…): their inbox rows are already consumed,
   * so an interjection carries them into the chain it starts instead of
   * losing them.
   */
  clear(): Array<{ botId: string; note: string }> {
    const carried = this.queue
      .filter((item) => item.reason === 'continue')
      .map((item) => ({ botId: item.botId, note: item.message ?? '' }));
    this.pendingAsks = [];
    this.queue = [];
    return carried;
  }

  /** Whether a chain budget already ran out. */
  get isLimited(): boolean {
    return this.limited;
  }

  get pending(): readonly FloorItem[] {
    return this.queue;
  }

  get speaking(): FloorItem | null {
    return this.current;
  }
}
