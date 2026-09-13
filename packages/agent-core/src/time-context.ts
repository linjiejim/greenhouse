/**
 * Time context injection — prepend timestamp tags to user messages.
 *
 * Helps the agent reason about relative dates ("yesterday", "last week")
 * without polluting the system prompt — which keeps LLM prefix caching intact.
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
 * Inject time context into chat messages.
 *
 * Prepends a timestamp tag to each user message based on its created_at.
 * The last user message additionally gets a [Current Time] marker.
 *
 * @param messages - Chat messages with optional created_at from DB
 * @param timezone - IANA timezone string (default: 'Asia/Shanghai')
 * @returns Messages with time annotations (created_at stripped)
 */
export function injectTimeContext(
  messages: EngineMessage[],
  timezone = 'Asia/Shanghai',
): Array<{ role: string; content: string | EngineContentPart[] }> {
  // Find the index of the last user message
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  return messages.map((msg, idx) => {
    if (msg.role !== 'user') {
      return { role: msg.role, content: msg.content };
    }

    const ts = msg.created_at ? new Date(msg.created_at) : null;
    const isLast = idx === lastUserIdx;

    let prefix = '';
    if (isLast) {
      // Last user message: use current time (most accurate for relative-date reasoning)
      const now = new Date();
      prefix = `[Current Time: ${formatTimestamp(now, timezone)}] `;
    } else if (ts && !isNaN(ts.getTime())) {
      // Historical user message: use its stored timestamp
      prefix = `[${formatTimestamp(ts, timezone)}] `;
    }

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
