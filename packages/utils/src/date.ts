/**
 * Shared date utilities.
 */

/**
 * Returns the current time as an ISO 8601 string.
 * PostgreSQL TIMESTAMPTZ columns parse this natively with full precision.
 * e.g. "2025-05-09T12:00:00.123Z"
 */
export function nowIso(): string {
  return new Date().toISOString();
}
