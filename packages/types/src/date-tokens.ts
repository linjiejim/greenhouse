/**
 * Relative date tokens for saved queries.
 *
 * A saved card or view literally storing `2026-08-04` is wrong tomorrow, so
 * stored configs carry tokens and the server expands them at evaluation time.
 * Deliberately a fixed vocabulary rather than an expression language — a stored
 * config stays inert data.
 *
 *   $today  $yesterday  $now
 *   $today-<N>d  $today+<N>d     N = 1..365
 *   $week_start (Monday)  $month_start
 *
 * Day tokens resolve in an IANA time zone (default UTC) and produce `YYYY-MM-DD`;
 * `$now` produces an ISO instant. Shared by the Home workbench and Tables.
 */

const DATE_TOKEN_PATTERN = /^\$(today|yesterday|now|week_start|month_start|today([+-])([0-9]{1,3})d)$/;

/** True when the string is one of the date tokens (does not validate N's range). */
export function isDateToken(value: string): boolean {
  return DATE_TOKEN_PATTERN.test(value.trim());
}

/** The calendar day of `instant` in `timeZone`, as a UTC-midnight Date. */
function localDay(instant: Date, timeZone: string): Date {
  let year = instant.getUTCFullYear();
  let month = instant.getUTCMonth();
  let day = instant.getUTCDate();
  if (timeZone !== 'UTC') {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(instant);
      const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
      year = pick('year');
      month = pick('month') - 1;
      day = pick('day');
    } catch {
      // An unknown zone falls back to UTC rather than failing the whole query.
    }
  }
  return new Date(Date.UTC(year, month, day));
}

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Expand one token, or return null when the string is not a (valid) date token. */
export function expandDateToken(value: string, now: Date, timeZone = 'UTC'): string | null {
  const match = DATE_TOKEN_PATTERN.exec(value.trim());
  if (!match) return null;
  if (match[1] === 'now') return now.toISOString();
  const base = localDay(now, timeZone);
  switch (match[1]) {
    case 'today':
      return toIsoDay(base);
    case 'yesterday':
      base.setUTCDate(base.getUTCDate() - 1);
      return toIsoDay(base);
    case 'month_start':
      base.setUTCDate(1);
      return toIsoDay(base);
    case 'week_start': {
      const weekday = (base.getUTCDay() + 6) % 7; // Monday = 0
      base.setUTCDate(base.getUTCDate() - weekday);
      return toIsoDay(base);
    }
    default: {
      const days = Number(match[3]);
      if (!Number.isFinite(days) || days < 1 || days > 365) return null;
      base.setUTCDate(base.getUTCDate() + (match[2] === '-' ? -days : days));
      return toIsoDay(base);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Expand date tokens recursively through a bounded JSON tree. */
export function expandDateTokens(
  input: Record<string, unknown>,
  now: Date,
  timeZone = 'UTC',
): Record<string, unknown> {
  const expand = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return expandDateToken(value, now, timeZone) ?? value;
    // Inputs are already bounded by their schemas; the depth guard is defence
    // against a malformed legacy JSON blob.
    if (depth >= 12) return value;
    if (Array.isArray(value)) return value.map((item) => expand(item, depth + 1));
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, depth + 1)]));
    }
    return value;
  };
  return expand(input, 0) as Record<string, unknown>;
}

/** The token that stands for the acting user in user-valued filter clauses. */
export const ME_TOKEN = '$me';
