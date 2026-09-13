/**
 * Client Action Bridge — connects a chat stream to browser-provided UI actions.
 *
 * A bridge is created for an authenticated session when the browser advertises
 * actions for the current screen. Calling one emits the legacy
 * `local-tool-request` wire event, then pauses the agent step until the same user
 * posts the result back through `/api/client-actions/tool-result`.
 */

import { waitForClientActionResult } from './client-action-pending.js';

/** Writes a single NDJSON event to the browser stream. */
export type ClientActionEventWriter = (event: Record<string, unknown>) => Promise<void>;

export interface ClientActionBridge {
  /** Provide the stream writer once the NDJSON response has opened. */
  setWriter(write: ClientActionEventWriter): void;
  /** Emit a request to the browser and await the real UI-action result. */
  requestExecution(actionId: string, params: Record<string, unknown>, toolCallId: string): Promise<unknown>;
}

export function createClientActionBridge(
  userId: string,
  sessionId: string,
  actionScopeId?: string,
  timeoutMs = 180_000,
): ClientActionBridge {
  let writer: ClientActionEventWriter | null = null;

  return {
    setWriter(write) {
      writer = write;
    },

    async requestExecution(actionId, params, toolCallId) {
      if (!writer) {
        return { error: 'Client action stream is not connected.' };
      }

      // Keep the event name for wire compatibility; it now represents browser
      // client actions only, never filesystem, shell, or other OS capabilities.
      // Register before writing: a fast browser may post the result as soon as
      // it receives the event, so registering afterward creates a lost-result race.
      const result = waitForClientActionResult(userId, sessionId, toolCallId, timeoutMs);
      await writer({
        type: 'local-tool-request',
        toolCallId,
        toolId: actionId,
        params,
        ...(actionScopeId ? { scopeId: actionScopeId } : {}),
      });
      const { output, error } = await result;

      if (error) return { error };
      return output;
    },
  };
}
