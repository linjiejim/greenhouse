/**
 * Chat API (NDJSON streaming) + browser Client Action result plumbing.
 *
 * Deliberately NOT on the hc client (see ./client.ts conventions):
 * - streamChat consumes NDJSON event streams via a
 *   hand-rolled reader — hc is for JSON request/response only.
 * - postClientActionResult talks to CLIENT_ACTION_RESULT_PATH, which is
 *   mounted dynamically and therefore absent from
 *   @greenhouse/contract AppType.
 * All functions stay on raw authFetch.
 */

import { authFetch } from '../auth';
import { readNdjsonStream } from '../stream-utils';
import { BotsApiError } from './bots';
import { CLIENT_ACTION_RESULT_PATH, requireChatStreamFinish } from '@greenhouse/types/api';
import type { StreamingEvent } from '../stream-events';
import type {
  ChatRequestBody,
  ChatRequestMessage,
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
  const body: ChatRequestBody = {
    session_id: sessionId,
  };
  if (message !== undefined) {
    const messagePayload: ChatRequestMessage = {
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

// ─── Bots conversations ─────────────────────────────────────

/**
 * Opening a Bots turn has two outcomes. An idle conversation answers with the
 * usual NDJSON stream; a busy one (a Bot is still talking) answers
 * `202 {queued:true}` — the message was delivered and the engine reads it
 * between Bot turns, so the composer never has to lock.
 */
export type BotsChatOpenResult = { queued: true } | { queued: false; events: AsyncGenerator<StreamEvent> };

export async function openBotsChat({
  sessionId,
  message,
  images,
  mentions,
  signal,
}: {
  sessionId: string;
  message: string;
  images?: Array<{ id: string; url: string }>;
  /** Bot ids the member addressed (`@Name`, or a leading "Name:"). */
  mentions?: string[];
  signal?: AbortSignal;
}): Promise<BotsChatOpenResult> {
  const messagePayload: ChatRequestMessage = { role: 'user', content: message };
  if (images && images.length > 0) messagePayload.images = images;
  const body: ChatRequestBody = { session_id: sessionId, messages: [messagePayload] };
  if (mentions && mentions.length > 0) body.mentions = mentions;
  const wsId = useUIStore.getState().activeWorkspace;
  if (wsId) body.workspace_id = wsId;

  const res = await authFetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 202) {
    await res.body?.cancel().catch(() => {});
    return { queued: true };
  }
  if (!res.ok) {
    const raw = await res.text();
    let reason = raw;
    let code: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; code?: unknown };
      if (typeof parsed.error === 'string') reason = parsed.error;
      if (typeof parsed.code === 'string') code = parsed.code;
    } catch {
      /* not JSON — keep the raw body */
    }
    // A Bots refusal carries a code (409 `bot_archived` / `no_active_members`:
    // nobody here can reply) the page turns into its read-only state.
    throw new BotsApiError(reason || `Chat error ${res.status}`, res.status, code);
  }
  const reader = res.body!.getReader();
  return { queued: false, events: requireChatStreamFinish(readNdjsonStream<StreamEvent>(reader)) };
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
  await authFetch(`${BASE}${CLIENT_ACTION_RESULT_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, ...result }),
  });
}
