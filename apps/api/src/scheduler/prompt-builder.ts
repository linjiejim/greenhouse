/**
 * Prompt builder for scheduled task execution.
 *
 * Injects date/time context into task prompts so the agent
 * knows "today" relative to the user's timezone.
 */

/**
 * The exact answer a quiet automation (`quiet_when_empty`) gives when a run has
 * nothing new to report. Compared after trimming, case-sensitive: anything else
 * — including a sentence that merely mentions it — is a normal answer.
 */
export const NO_UPDATE_SENTINEL = 'NO_UPDATE';

/** Summary stored on a quiet run that reported nothing new. */
export const NO_UPDATE_SUMMARY = 'No update — nothing new to report.';

const QUIET_WHEN_EMPTY_INSTRUCTION =
  `\n\n[若本次没有任何新的、值得报告的内容，只回复 ${NO_UPDATE_SENTINEL}（不要加任何其他文字）。` +
  ` If there is nothing new worth reporting this time, reply with exactly ${NO_UPDATE_SENTINEL} and nothing else.]`;

/**
 * True when a quiet automation's final answer is the no-update sentinel AND the
 * run actually looked at something (at least one tool call). A bare NO_UPDATE
 * with zero tool calls means the model checked nothing, so it is stored and
 * delivered as a normal answer instead of being silently filed as "no update".
 */
export function isNoUpdateAnswer(
  quietWhenEmpty: boolean | null | undefined,
  answer: string | null | undefined,
  toolCallCount: number,
): boolean {
  return quietWhenEmpty === true && toolCallCount > 0 && (answer ?? '').trim() === NO_UPDATE_SENTINEL;
}

/**
 * Build the final prompt for a scheduled task execution.
 * Prepends date/time/timezone context to the raw task prompt; a quiet
 * automation also gets the no-update instruction appended.
 */
export function buildTaskPrompt(
  taskPrompt: string,
  timezone: string,
  reference = new Date(),
  options: { quietWhenEmpty?: boolean } = {},
): string {
  const now = reference;

  // Format date in user's timezone
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dateStr = formatter.format(now);

  // Also provide ISO date for tool calls that need it
  const isoFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const isoDate = isoFormatter.format(now); // YYYY-MM-DD

  const contextPrefix = `[当前时间: ${dateStr} | 日期: ${isoDate} | 时区: ${timezone}]\n\n`;

  return contextPrefix + taskPrompt + (options.quietWhenEmpty ? QUIET_WHEN_EMPTY_INSTRUCTION : '');
}

/**
 * Generate a session title for a task execution.
 * Format: [任务名] YYYY-MM-DD HH:mm
 */
export function buildTaskSessionTitle(taskName: string, timezone: string, reference = new Date()): string {
  const now = reference;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  const h = parts.find((p) => p.type === 'hour')?.value;
  const min = parts.find((p) => p.type === 'minute')?.value;

  return `[${taskName}] ${y}-${m}-${d} ${h}:${min}`;
}
