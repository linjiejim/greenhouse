/**
 * The Bot turn context — what every Bot tool factory receives.
 *
 * One object per Bot turn (foreground or background). Tools never reach for a
 * global "current turn": they get the Bot, the conversation, the owner and the
 * running ChatRun from here, which is what makes them unbuildable outside the
 * Bots engine (and why they are `special` in the tool catalog).
 *
 * Contract between the engine (bots/engine), the computer (bots/computer) and
 * the vault (bots/vault). Design: docs/specs/20261005-personal-assistant-bots.md.
 */

import type { DatabaseProvider, BotRow, BotRequestRow } from '@greenhouse/db';
import type { BotApprovalPayload, BotRequestKind, BotRequestPayload, BotTurnReason } from '@greenhouse/types/bots';

/** The decision a person made on an in-turn approval card. */
export type ApprovalDecision = 'approve' | 'always' | 'deny' | 'expired';

export interface BotTurnContext {
  db: DatabaseProvider;
  /** The member who owns the conversation, the Bot and the computer. Always the session owner. */
  userId: string;
  userRole: 'super' | 'team';
  /** Owner's UI locale — copy for system events and cards ('en' | 'zh'). */
  locale: 'en' | 'zh';
  /** The Bots conversation (session id). */
  sessionId: string;
  bot: BotRow;
  /** Why this Bot is speaking. Anything other than `user`/`mention`/`interjection` is not user-triggered. */
  reason: BotTurnReason;
  /** True when the turn answers the member directly (stricter rules apply otherwise, e.g. vault fills always ask). */
  userTriggered: boolean;
  /** True for background tasks: read-only tool face, no cards that wait on a person. */
  background: boolean;
  /** Identifies this turn for tab leases and approval binding (`<chatRunId>:<turnIndex>` or the task run id). */
  turnId: string;
  /** Aborts with the run (user Stop, shutdown, budget). */
  signal: AbortSignal;

  /** Push a wire event into the running stream (no-op for background turns). */
  emit(event: Record<string, unknown> & { type: string }): void;

  /**
   * Raise a "needs you" request: persist a `bot_requests` row, push a
   * `bot-request` stream event and an in-app notification. Returns the row.
   * The card binds to the row id; settling goes through POST /api/bots/requests/:id.
   */
  createRequest(
    kind: BotRequestKind,
    payload: BotRequestPayload,
    opts?: { expiresInMs?: number },
  ): Promise<BotRequestRow>;

  /**
   * Raise an approval card and WAIT for the decision inside the tool call
   * (bounded by `timeoutMs`, at most 110 s — the engine's stream chunk timeout
   * of 120 s also spans tool execution — and by `signal`). Background turns
   * resolve `deny` immediately — nobody is there to click.
   */
  requestApproval(payload: BotApprovalPayload, opts?: { timeoutMs?: number }): Promise<ApprovalDecision>;

  /**
   * Mark that this turn has read untrusted content (a web page, a shell
   * output, a file). From then on memory writes default to the Bot's private
   * scope and greenhouse writes always need an approval.
   */
  markTainted(): void;
  isTainted(): boolean;

  /**
   * Accepted hand-offs (team.ask) and take-over requests set this; the engine
   * ends the turn after the current step (stopWhen) and reads the hand-offs.
   */
  stopAfterStep(reason: 'handoff' | 'takeover'): void;
  /** Hand-offs accepted this turn, in order (consumed by the floor controller). */
  readonly handoffs: Array<{ toBotId: string; message: string }>;
}

/** A Bot tool factory: builds one AI SDK tool for one turn. */
export type BotToolFactory<T = unknown> = (ctx: BotTurnContext) => T;
