/**
 * IM gateway — shared types & constants.
 *
 * The gateway normalizes every platform's inbound event into `InboundMessage`,
 * routes it through the channel-agnostic dispatcher (dispatch.ts), and lets each
 * platform worker render the reply. `ChannelWorker` is the seam a new platform
 * adapter implements (Telegram is the first — see telegram/worker.ts). This is a
 * real, single-consumer seam today; extend it (not fork the dispatcher) when a
 * second platform lands.
 */

/** A normalized inbound message, platform-independent. */
export interface InboundMessage {
  channel: 'telegram';
  /** Platform user id (string form). */
  extUserId: string;
  /** Chat id to deliver the reply to (for a DM this equals extUserId). */
  extChatId: string;
  /** The message text (already trimmed; may be empty for non-text messages). */
  text: string;
  /** Best-effort display name for the sender. */
  displayName?: string;
  /** A leading slash command without the slash, lowercased (e.g. 'start'). */
  command?: string;
  /** The argument following a slash command (e.g. the pairing code for /start). */
  commandArg?: string;
}

/** A running per-bot worker. One platform adapter = one ChannelWorker impl. */
export interface ChannelWorker {
  readonly botId: string;
  /** Begin receiving (non-blocking — spins the receive loop in the background). */
  start(): void;
  /** Stop receiving and release resources. Resolves once the loop has exited. */
  stop(): Promise<void>;
}

/** How many prior turns (user+assistant messages) to feed as conversation memory. */
export const IM_MAX_HISTORY_MESSAGES = 40;

/** Telegram hard limit for a single outbound message body. */
export const TELEGRAM_MAX_MESSAGE = 4096;

/** Pairing-code lifetime. */
export const PAIRING_CODE_TTL_MS = 15 * 60_000;

/** Per-identity inbound rate limit (messages / minute). */
export const IM_RATE_LIMIT_PER_MIN = 20;
