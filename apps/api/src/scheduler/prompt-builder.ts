/**
 * Prompt builder for scheduled task execution.
 *
 * Injects date/time context into task prompts so the agent
 * knows "today" relative to the user's timezone.
 */

/**
 * Build the final prompt for a scheduled task execution.
 * Prepends date/time/timezone context to the raw task prompt.
 */
export function buildTaskPrompt(taskPrompt: string, timezone: string): string {
  const now = new Date();

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

  return contextPrefix + taskPrompt;
}

/**
 * Generate a session title for a task execution.
 * Format: [任务名] YYYY-MM-DD HH:mm
 */
export function buildTaskSessionTitle(taskName: string, timezone: string): string {
  const now = new Date();
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
