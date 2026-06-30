/**
 * Time context injection — prepend timestamp tags to user messages.
 *
 * Helps the agent reason about relative dates ("yesterday", "last week")
 * without polluting the system prompt — which keeps LLM prefix caching intact.
 */

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
 * @param timezone - IANA timezone string (default: 'UTC')
 * @returns Messages with time annotations (created_at stripped)
 */
export function injectTimeContext(
  messages: Array<{ role: string; content: string; created_at?: string }>,
  timezone = 'UTC',
): Array<{ role: string; content: string }> {
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

    return { role: msg.role, content: prefix + msg.content };
  });
}
