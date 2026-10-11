/**
 * Helpers shared by the Tables client modules. Not re-exported from the barrel.
 */

/**
 * A failed Tables request. Keeps the HTTP status and the server's `details`
 * (a 409 carries `currentRevision`) so callers can recover instead of only
 * showing a message.
 */
export class TablesRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'TablesRequestError';
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

export async function responseError(response: Response, fallback: string): Promise<TablesRequestError> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; details?: Record<string, unknown> };
  return new TablesRequestError(body.error || fallback, response.status, body.details);
}

export function isTablesConflict(error: unknown): error is TablesRequestError {
  return error instanceof TablesRequestError && error.isConflict;
}
