/**
 * Time context injection — prepend timestamp tags to user messages.
 *
 * Helps the agent reason about relative dates ("yesterday", "last week")
 * without polluting the system prompt — which keeps LLM prefix caching intact.
 * Every stamp is derived from the message itself, never from the clock, so a
 * message renders identically on every turn after it was sent.
 */

/**
 * A user-content part hosts may pass instead of a plain string. Only vision
 * hosts build these (inlined image attachments for models the catalog marks
 * `vision: true`); everything else keeps sending strings.
 */
export type EngineContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: Uint8Array | URL; mediaType?: string };

/** The message shape every engine entry point accepts. */
export interface EngineMessage {
  role: string;
  content: string | EngineContentPart[];
  created_at?: string;
}

const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Format a Date to a human-readable timestamp string in a given timezone.
 * Example: "2026-05-21 Wednesday 00:36"
 */
function formatTimestamp(date: Date, tz: string): string {
  // Use Intl to get parts in the target timezone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  const timeStr = `${get('hour')}:${get('minute')}`;

  // Get day of week in target timezone
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  const weekday = WEEKDAYS_EN[tzDate.getDay()];

  return `${dateStr} ${weekday} ${timeStr}`;
}

/**
 * The "now" line a host puts in the closing turn-context block of the newest
 * user message (apps/api/src/chat/turn-context.ts). Kept out of the stamps
 * below so they are a pure function of the transcript.
 */
export function formatCurrentTimeLine(now: Date = new Date(), timezone = 'Asia/Shanghai'): string {
  return `[Current Time: ${formatTimestamp(now, timezone)}]`;
}

/**
 * Inject time context into chat messages.
 *
 * Prepends each user message's own stored timestamp (`created_at`). The
 * result is a pure function of the transcript — the same message renders the
 * same bytes on every later turn — so the provider's prefix cache keeps
 * hitting across turns. The live current time is NOT added here any more: it
 * changes every request, so hosts put it in the closing block they append to
 * the newest user message (see `formatCurrentTimeLine`).
 *
 * @param messages - Chat messages with optional created_at from DB
 * @param timezone - IANA timezone string (default: 'Asia/Shanghai')
 * @returns Messages with time annotations (created_at stripped)
 */
export function injectTimeContext(
  messages: EngineMessage[],
  timezone = 'Asia/Shanghai',
): Array<{ role: string; content: string | EngineContentPart[] }> {
  return messages.map((msg) => {
    if (msg.role !== 'user') {
      return { role: msg.role, content: msg.content };
    }

    const ts = msg.created_at ? new Date(msg.created_at) : null;
    const prefix = ts && !isNaN(ts.getTime()) ? `[${formatTimestamp(ts, timezone)}] ` : '';

    if (typeof msg.content === 'string') {
      return { role: msg.role, content: prefix + msg.content };
    }

    // Multimodal content: the timestamp rides the first text part (or a new
    // leading one for image-only turns) so image parts stay untouched.
    if (!prefix) return { role: msg.role, content: msg.content };
    const parts = [...msg.content];
    const textIdx = parts.findIndex((p) => p.type === 'text');
    if (textIdx >= 0) {
      const textPart = parts[textIdx] as { type: 'text'; text: string };
      parts[textIdx] = { ...textPart, text: prefix + textPart.text };
    } else {
      parts.unshift({ type: 'text', text: prefix.trimEnd() });
    }
    return { role: msg.role, content: parts };
  });
}
