/**
 * Local Tool Bridge — connects a chat stream to the Desktop client's local runtime.
 *
 * A per-request bridge is created when a session uses local tools. Its `requestExecution`
 * is wired into each local tool's execute(): it emits a `local-tool-request` event to the
 * client (via the NDJSON writer) and then awaits the real result before resolving — so the
 * agent step blocks until the client has actually executed the tool and posted back.
 */

import { waitForLocalToolResult } from './pending.js';

/** Writes a single NDJSON event to the client stream. */
export type LocalEventWriter = (event: Record<string, unknown>) => Promise<void>;

export interface LocalToolBridge {
  /** Provide the stream writer once the NDJSON response has opened. */
  setWriter(write: LocalEventWriter): void;
  /**
   * Emit a local-tool-request to the client and await the executed result.
   * Returns the real tool output (or an `{ error }` object the model can react to).
   */
  requestExecution(toolId: string, params: Record<string, unknown>, toolCallId: string): Promise<unknown>;
}

export function createLocalToolBridge(sessionId: string, timeoutMs = 180_000): LocalToolBridge {
  let writer: LocalEventWriter | null = null;

  return {
    setWriter(w: LocalEventWriter) {
      writer = w;
    },

    async requestExecution(toolId, params, toolCallId) {
      if (!writer) {
        return { error: 'Local runtime is not connected (Desktop stream unavailable).' };
      }

      // Emit the request to the client immediately, then pause until it posts the result.
      await writer({ type: 'local-tool-request', toolCallId, toolId, params });
      const { output, error } = await waitForLocalToolResult(sessionId, toolCallId, timeoutMs);

      if (error) {
        // Surface the failure/denial as the tool result so the model can adapt.
        return { error };
      }
      return output;
    },
  };
}
