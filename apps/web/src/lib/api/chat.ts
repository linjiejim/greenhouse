/**
 * Chat API (NDJSON streaming) + client-tool plumbing.
 *
 * Deliberately NOT on the hc client (see ./client.ts conventions):
 * - streamChat / streamChatStateless consume NDJSON event streams via a
 *   hand-rolled reader — hc is for JSON request/response only.
 * - postLocalToolResult talks to /api/client-tools/result, a route that is
 *   mounted dynamically and therefore absent from @greenhouse/contract AppType.
 * All functions stay on raw authFetch.
 */

import { authFetch } from '../auth';
import { readNdjsonStream } from '../stream-utils';
import type { StreamingEvent } from '../stream-events';
import type { ClientActionDescriptor } from '@greenhouse/types/api';

type StreamEvent = StreamingEvent;

const BASE = '';

export async function* streamChat(
  sessionId: string,
  message: string,
  images?: Array<{ id: string; url: string }>,
  abortSignal?: AbortSignal,
  modelOverride?: string,
  contextHint?: string,
  clientActions?: ClientActionDescriptor[],
): AsyncGenerator<StreamEvent> {
  const messagePayload: { role: string; content: string; images?: Array<{ id: string; url: string }> } = {
    role: 'user',
    content: message,
  };
  if (images && images.length > 0) {
    messagePayload.images = images;
  }

  const body: Record<string, unknown> = {
    session_id: sessionId,
    messages: [messagePayload],
  };
  if (modelOverride) {
    body.model_override = modelOverride;
  }
  if (contextHint) {
    body.context_hint = contextHint;
  }
  if (clientActions && clientActions.length > 0) {
    body.client_actions = clientActions;
  }

  const res = await authFetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Chat error ${res.status}: ${err}`);
  }

  const reader = res.body!.getReader();
  yield* readNdjsonStream<StreamEvent>(reader);
}

/**
 * Stateless chat streaming — for external users without sessions.
 * Sends messages directly without session creation.
 */
export async function* streamChatStateless(
  messages: Array<{ role: string; content: string }>,
  profileId?: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await authFetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      profile_id: profileId || 'default',
    }),
    signal: abortSignal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Chat error ${res.status}: ${err}`);
  }

  const reader = res.body!.getReader();
  yield* readNdjsonStream<StreamEvent>(reader);
}

// ─── Client Tool Result ──────────────────────────────

/**
 * Post a client-action (browser UI tool) execution result back to the backend.
 * The agent stream issues a client-action request and waits for this result.
 */
export async function postLocalToolResult(
  sessionId: string,
  result: { toolCallId: string; output: unknown; error?: string },
): Promise<void> {
  await authFetch(`${BASE}/api/client-tools/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, ...result }),
  });
}
