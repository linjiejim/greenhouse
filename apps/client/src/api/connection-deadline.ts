/** One wall-clock budget for a connection attempt, including response bodies and retries.
 * Mobile is installed separately from workspace packages; keep this native-safe helper here.
 */
export const CONNECTION_TIMEOUT_MS = 10_000;

export class ConnectionTimeoutError extends Error {
  constructor() {
    super('Station connection timed out');
    this.name = 'ConnectionTimeoutError';
  }
}

export function checkAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Connection cancelled');
}

export async function withConnectionDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  controller = new AbortController(),
  timeoutMs = CONNECTION_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason ?? new Error('Connection cancelled'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new ConnectionTimeoutError();
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    // Racing also covers native fetch/storage implementations that ignore abort.
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
