/**
 * Error utilities.
 */

/**
 * Normalize an unknown thrown value into a human-readable message.
 * Replaces the `err instanceof Error ? err.message : String(err)` idiom.
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a thrown value is a PostgreSQL unique-constraint violation (23505).
 *
 * Drizzle wraps driver errors in a DrizzleQueryError, so the pg code sits on
 * `err.cause.code`, NOT on `err.code` — checking only the top level silently
 * never matches and turns "that name is taken" into a 500. Both levels are
 * checked here so the same call works whether the caller is holding a raw
 * postgres.js error or a wrapped one.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, cause, message } = err as {
    code?: unknown;
    cause?: { code?: unknown; message?: unknown };
    message?: unknown;
  };
  if (code === '23505' || cause?.code === '23505') return true;
  // Last-resort fallback for wrappers that drop the code but keep the text.
  return (
    (typeof message === 'string' && message.includes('unique')) ||
    (typeof cause?.message === 'string' && cause.message.includes('unique'))
  );
}
