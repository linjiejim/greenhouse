/**
 * Pending local-tool results — bridge between the chat stream and the Desktop client.
 *
 * Flow (client-side execution pattern):
 * 1. A local tool's execute() emits a `local-tool-request` to the client and then
 *    `await waitForLocalToolResult(sessionId, toolCallId)` — pausing the agent step.
 * 2. The Desktop client executes the tool locally and POSTs the result to
 *    /api/client-tools/result, which calls `resolveLocalToolResult(...)`.
 * 3. The awaiting promise resolves and the real output flows back into the model.
 *
 * Without this registry the request half-loop would never close — the model would
 * only ever see the proxy marker, never the real local output.
 */

interface PendingResult {
  resolve: (value: { output: unknown; error?: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
}

const pendingResults = new Map<string, PendingResult>();

/** Periodic sweep: drop entries older than the max age (stale / disconnected clients). */
const STALE_SWEEP_MS = 30_000;
const MAX_PENDING_AGE_MS = 300_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, pending] of pendingResults) {
    if (now - pending.createdAt > MAX_PENDING_AGE_MS) {
      clearTimeout(pending.timeout);
      pending.resolve({ output: null, error: 'Local tool request abandoned (client disconnected)' });
      pendingResults.delete(key);
    }
  }
}, STALE_SWEEP_MS).unref();

function keyFor(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

/**
 * Wait for a local tool result from the Desktop client.
 * Called by the local-tool bridge while the agent step is paused.
 *
 * @param timeoutMs - default 180s, generous enough to cover human confirmation in "ask" mode.
 */
export function waitForLocalToolResult(
  sessionId: string,
  toolCallId: string,
  timeoutMs = 180_000,
): Promise<{ output: unknown; error?: string }> {
  const key = keyFor(sessionId, toolCallId);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingResults.delete(key);
      resolve({ output: null, error: `Local tool execution timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    pendingResults.set(key, { resolve, timeout, createdAt: Date.now() });
  });
}

/**
 * Resolve a pending local tool result (called by the Desktop route handler).
 * @returns true if a waiting request was found and resolved.
 */
export function resolveLocalToolResult(
  sessionId: string,
  toolCallId: string,
  output: unknown,
  error?: string,
): boolean {
  const key = keyFor(sessionId, toolCallId);
  const pending = pendingResults.get(key);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingResults.delete(key);
  pending.resolve({ output, error });
  return true;
}
