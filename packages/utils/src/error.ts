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
