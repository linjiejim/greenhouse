/**
 * Pending browser client-action results.
 *
 * A chat tool call registers a pending result before emitting the legacy
 * `local-tool-request` event. The authenticated browser posts the result to
 * `/api/client-actions/tool-result`; the matching agent step then resumes.
 * Pending keys include the user id so one internal user cannot resolve another
 * user's action, even if session and tool-call identifiers are disclosed.
 */

interface PendingResult {
  resolve: (value: { output: unknown; error?: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
}

const pendingResults = new Map<string, PendingResult>();

/** Periodic sweep: release stale entries left by disconnected browsers. */
const STALE_SWEEP_MS = 30_000;
const MAX_PENDING_AGE_MS = 300_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, pending] of pendingResults) {
    if (now - pending.createdAt > MAX_PENDING_AGE_MS) {
      clearTimeout(pending.timeout);
      pending.resolve({ output: null, error: 'Client action request abandoned (browser disconnected)' });
      pendingResults.delete(key);
    }
  }
}, STALE_SWEEP_MS).unref();

function keyFor(userId: string, sessionId: string, toolCallId: string): string {
  return `${userId}:${sessionId}:${toolCallId}`;
}

/** Wait for the authenticated browser to return a client-action result. */
export function waitForClientActionResult(
  userId: string,
  sessionId: string,
  toolCallId: string,
  timeoutMs = 180_000,
): Promise<{ output: unknown; error?: string }> {
  const key = keyFor(userId, sessionId, toolCallId);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingResults.delete(key);
      resolve({ output: null, error: `Client action timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    pendingResults.set(key, { resolve, timeout, createdAt: Date.now() });
  });
}

/** Resolve a pending result owned by the authenticated user. */
export function resolveClientActionResult(
  userId: string,
  sessionId: string,
  toolCallId: string,
  output: unknown,
  error?: string,
): boolean {
  const key = keyFor(userId, sessionId, toolCallId);
  const pending = pendingResults.get(key);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingResults.delete(key);
  pending.resolve({ output, error });
  return true;
}
