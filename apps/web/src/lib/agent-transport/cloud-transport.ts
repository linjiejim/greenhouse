/**
 * CloudAgentTransport — drives a cloud session through the server NDJSON stream.
 *
 * Maps the server's StreamingEvent protocol onto the backend-agnostic RuntimeEvent
 * stream, so chat.tsx can use a single AgentTransport regardless of cloud or desktop.
 *
 * Streaming is fire-and-forget: prompt() kicks off the fetch, events flow through
 * the onEvent callback, and the transport completes on finish/error.
 */

import * as api from '../api';
import { handleStreamEvent } from '../stream-events';
import type { AgentTransport, RuntimeEvent } from './types';

export interface CloudTransportConfig {
  sessionId: string;
  images?: Array<{ id: string; url: string }>;
  modelOverride?: string;
  contextHint?: string;
  /** Called when the server generates a title for the session. */
  onTitle?: (title: string) => void;
  /** Called when the server requests a local tool execution (Desktop bridge). */
  onLocalToolRequest?: (toolCallId: string, toolId: string, params: Record<string, unknown>) => void;
}

export class CloudAgentTransport implements AgentTransport {
  private abortController: AbortController | null = null;
  private onEvent: ((event: RuntimeEvent) => void) | null = null;

  constructor(private readonly config: CloudTransportConfig) {}

  async start(onEvent: (event: RuntimeEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  async prompt(text: string): Promise<void> {
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.streamInBackground(text, this.abortController);
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
  }

  async dispose(): Promise<void> {
    await this.abort();
    this.onEvent = null;
  }

  private streamInBackground(text: string, controller: AbortController): void {
    const { sessionId, images, modelOverride, contextHint, onTitle, onLocalToolRequest } = this.config;
    const emit = (event: RuntimeEvent) => this.onEvent?.(event);

    (async () => {
      try {
        const stream = api.streamChat(sessionId, text, images, controller.signal, modelOverride, contextHint);

        for await (const event of stream) {
          handleStreamEvent(event, {
            onTextDelta: (t) => emit({ type: 'text-delta', text: t }),
            onReasoningDelta: (t) => emit({ type: 'reasoning-delta', text: t }),
            onToolCallStart: (id, toolName) =>
              emit({ type: 'tool-call-start', toolCallId: id, toolName, args: undefined }),
            onToolCallDelta: (id, delta) =>
              emit({ type: 'tool-call-delta', toolCallId: id, toolName: '', partial: delta }),
            onToolResult: (id, toolName, output) =>
              emit({ type: 'tool-result', toolCallId: id, toolName, result: output, isError: false }),
            onError: (msg) => emit({ type: 'error', message: msg }),
            onTitle: (title) => onTitle?.(title),
            onLocalToolRequest: (toolCallId, toolId, params) => onLocalToolRequest?.(toolCallId, toolId, params),
          });
        }

        emit({ type: 'finish' });
      } catch (err: unknown) {
        if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') return;
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }
}
