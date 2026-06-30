/**
 * Local tool marker — the cross-host convention for client-side tool execution.
 *
 * Server-registered local tools don't execute on the server: they return this
 * marker, the engine surfaces it in the stream (StreamCollectors
 * .localToolRequests), and the host client (Desktop bridge / web executor)
 * performs the actual operation.
 */

/** Marker returned by local tools to signal client-side execution. */
export interface LocalToolMarker {
  __local: true;
  toolId: string;
  params: Record<string, unknown>;
}

export function createLocalMarker(toolId: string, params: Record<string, unknown>): LocalToolMarker {
  return { __local: true, toolId, params };
}

/** Check if a tool result is a local execution marker. */
export function isLocalToolMarker(result: unknown): result is LocalToolMarker {
  return (
    typeof result === 'object' &&
    result !== null &&
    '__local' in result &&
    (result as Record<string, unknown>).__local === true
  );
}
