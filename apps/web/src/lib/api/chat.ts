/**
 * Chat API (NDJSON streaming) + browser Client Action result plumbing.
 *
 * Deliberately NOT on the hc client (see ./client.ts conventions):
 * - streamChat consumes NDJSON event streams via a
 *   hand-rolled reader — hc is for JSON request/response only.
 * - postClientActionResult talks to `/api/client-actions/tool-result`, which is
 *   mounted dynamically and therefore absent from
 *   @greenhouse/contract AppType.
 * All functions stay on raw authFetch.
 */

import { authFetch } from '../auth';
import { readNdjsonStream } from '../stream-utils';
import { requireChatStreamFinish } from '@greenhouse/types/api';
import type { StreamingEvent } from '../stream-events';
import type {
  ChatRunInfo,
  ChatTurnEnvironment,
  ClientActionDescriptor,
  ReplayableStreamEvent,
} from '@greenhouse/types/api';
import { useUIStore } from '../../stores';

type StreamEvent = StreamingEvent;

export type { ChatRunInfo };

const BASE = '';

export async function* streamChat(
  sessionId: string,
  message: string | undefined,
  images?: Array<{ id: string; url: string }>,
  abortSignal?: AbortSignal,
  environment?: ChatTurnEnvironment,
  regenerateAssistantMessageId?: string,
): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = {
    session_id: sessionId,
  };
  if (message !== undefined) {
    const messagePayload: { role: string; content: string; images?: Array<{ id: string; url: string }> } = {
      role: 'user',
      content: message,
    };
    if (images && images.length > 0) messagePayload.images = images;
    body.messages = [messagePayload];
  } else if (images?.length) {
    throw new Error('Images require a user message.');
  }
  if (regenerateAssistantMessageId) {
    if (message !== undefined || images?.length) {
      throw new Error('Regeneration cannot include a new user message or images.');
    }
    body.regenerate_assistant_message_id = regenerateAssistantMessageId;
  }
  if (environment?.ambientContext) {
    body.ambient_context = environment.ambientContext;
  }
  if (environment?.model) {
    body.model = environment.model;
  }
  if (environment?.clientActions?.actions.length) {
    body.client_action_scope_id = environment.clientActions.scopeId;
    body.client_actions = environment.clientActions.actions satisfies ClientActionDescriptor[];
  }

  // Pass active workspace for per-user tool proxy
  const wsId = useUIStore.getState().activeWorkspace;
  if (wsId) {
    body.workspace_id = wsId;
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
  yield* requireChatStreamFinish(readNdjsonStream<StreamEvent>(reader));
}

// ─── Background Runs (reconnectable generations) ────────────

/** A stream event as delivered on the wire — may carry the run's replay cursor. */
export type SeqStreamEvent = ReplayableStreamEvent;

/** Probe whether a session has an in-flight (or just-ended, still replayable) run. */
export async function getChatRun(sessionId: string): Promise<{ active: boolean; run?: ChatRunInfo }> {
  const res = await authFetch(`${BASE}/api/chat/runs/${sessionId}`);
  if (!res.ok) throw new Error(`Run probe failed: ${res.status}`);
  return res.json();
}

/** All of the caller's in-flight runs — seeds streaming state after a page load. */
export async function listChatRuns(): Promise<{
  runs: Array<{ session_id: string; run_id: string; started_at: number; next_seq: number }>;
}> {
  const res = await authFetch(`${BASE}/api/chat/runs`);
  if (!res.ok) throw new Error(`Run list failed: ${res.status}`);
  return res.json();
}

/**
 * Attach to a session's run: the server replays buffered events with
 * seq > afterSeq, then tails live until the turn ends. Same NDJSON protocol
 * and finish guard as the original POST stream.
 */
export async function* streamChatRun(
  sessionId: string,
  afterSeq: number,
  abortSignal?: AbortSignal,
): AsyncGenerator<SeqStreamEvent> {
  const res = await authFetch(`${BASE}/api/chat/runs/${sessionId}/stream?after=${afterSeq}`, {
    signal: abortSignal,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Chat reconnect error ${res.status}: ${err}`);
  }
  const reader = res.body!.getReader();
  yield* requireChatStreamFinish(readNdjsonStream<SeqStreamEvent>(reader)) as AsyncGenerator<SeqStreamEvent>;
}

/**
 * Server-side stop: aborts the agent loop itself (the run would otherwise keep
 * generating in the cloud). Returns false when there is nothing to stop.
 */
export async function stopChatRun(sessionId: string): Promise<boolean> {
  const res = await authFetch(`${BASE}/api/chat/runs/${sessionId}/stop`, { method: 'POST' });
  return res.ok;
}

// ─── Browser Client Action Result ───────────────────────────

/**
 * Post a browser Client Action result back to the paused agent turn.
 */
export async function postClientActionResult(
  sessionId: string,
  result: { toolCallId: string; output: unknown; error?: string },
): Promise<void> {
  await authFetch(`${BASE}/api/client-actions/tool-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, ...result }),
  });
}
