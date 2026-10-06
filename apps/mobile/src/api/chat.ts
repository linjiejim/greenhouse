/**
 * Chat streaming — POST /api/chat and the reconnectable "runs" endpoints, both
 * consumed as NDJSON.
 *
 * Uses `expo/fetch` (SDK 52+) instead of React Native's built-in fetch because
 * only expo/fetch exposes a streaming `response.body` reader on native. On web
 * it maps to the browser fetch (which also streams). This is the same path the
 * Vercel AI SDK uses for Expo.
 *
 * Generation is decoupled from the HTTP response on the server
 * (apps/api/src/routes/chat.ts): the agent loop pumps into a per-session run
 * buffer and the POST response is just its first subscriber. So, mirroring the
 * web client (apps/web/src/lib/api/chat.ts):
 *  - `streamChat` starts a turn — a new user turn (`message`, optional
 *    `images`), a regeneration of the tail reply (`regenerateAssistantMessageId`,
 *    no message — replaced in place), or a bare continuation (neither — the
 *    server answers the persisted tail user turn),
 *  - `getChatRun` probes whether a session has a generation in flight,
 *  - `streamChatRun` re-attaches to it (replays buffered events after `after`,
 *    then tails live — same protocol, events carry `seq` / `replayed`),
 *  - `stopChatRun` stops the generation itself (aborting the local fetch only
 *    detaches; the run would keep generating, billing and holding the
 *    session's one-run slot — a follow-up send would get 409).
 *
 * Yields the canonical `StreamingEvent` union (vendored from @greenhouse/types)
 * so callers can drive it through `handleStreamEvent`.
 */

import { fetch as expoFetch } from 'expo/fetch';
import type { StreamingEvent } from '../shared/greenhouse-types';
import { t } from '../lib/i18n';
import { getApiBase } from '../store/stations';
import { getAccessToken } from './token-storage';
import { api, refreshTokens } from './client';

/** A wire event; run streams stamp the replay cursor (`seq`) and `replayed`. */
export type RunStreamEvent = StreamingEvent & { seq?: number; replayed?: boolean };

interface StreamChatArgs {
  sessionId: string;
  /** The new user turn. Omit for a regeneration or a continuation. */
  message?: string;
  /** Uploaded images to attach to the user message (see /api/upload). */
  images?: Array<{ id: string; url: string }>;
  /** Server id of the tail assistant reply to regenerate (no `message` allowed). */
  regenerateAssistantMessageId?: string;
  modelOverride?: string;
  signal?: AbortSignal;
}

/** A non-OK response from a chat endpoint (`status` tells a busy 409 / a gone 404 apart). */
export class ChatHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Shape of `GET /api/chat/runs/:sessionId` (vendored `ChatRunInfo`). */
export interface ChatRunProbe {
  active: boolean;
  run?: { run_id: string; status: 'running' | 'completed' | 'error'; started_at: number; next_seq: number };
}

/** An authenticated expo/fetch with one refresh+retry on 401 (before the body is read). */
async function openAuthed(path: string, init: { method: string; body?: string; signal?: AbortSignal }) {
  const go = (token: string | null) => {
    const headers: Record<string, string> = {};
    if (init.body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    return expoFetch(`${getApiBase()}${path}`, { ...init, headers });
  };
  let res = await go(getAccessToken());
  if (res.status === 401 && (await refreshTokens())) res = await go(getAccessToken());
  return res;
}

/** Pull the server's `{ error }` message out of a failed response body, if any. */
function errorDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    /* not JSON */
  }
  return raw.slice(0, 200);
}

/** Turn a non-OK stream response into a user-facing error. */
async function failure(res: { status: number; text(): Promise<string> }): Promise<ChatHttpError> {
  // 409 = the session's previous reply is still being generated (one run per
  // session) — say so instead of surfacing the server's English.
  if (res.status === 409) return new ChatHttpError(t('chat.busy'), 409);
  let detail = '';
  try {
    detail = errorDetail(await res.text());
  } catch {
    /* ignore */
  }
  return new ChatHttpError(`${t('chat.requestFailed')} (${res.status})${detail ? `: ${detail}` : ''}`, res.status);
}

/** Read an NDJSON response body event by event. */
async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<RunStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const evt = line ? parseLine(line) : null;
        if (evt) yield evt;
      }
    }
    const tail = buffer.trim();
    const evt = tail ? parseLine(tail) : null;
    if (evt) yield evt;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      /* ignore */
    }
  }
}

function parseLine(line: string): RunStreamEvent | null {
  try {
    return JSON.parse(line) as RunStreamEvent;
  } catch {
    return null;
  }
}

/** Start a turn (POST /api/chat) and stream its events. */
export async function* streamChat(args: StreamChatArgs): AsyncGenerator<RunStreamEvent> {
  const body: Record<string, unknown> = { session_id: args.sessionId };
  if (args.message !== undefined) {
    body.messages = [
      {
        role: 'user',
        content: args.message,
        ...(args.images?.length ? { images: args.images } : {}),
      },
    ];
  }
  if (args.regenerateAssistantMessageId) body.regenerate_assistant_message_id = args.regenerateAssistantMessageId;
  if (args.modelOverride) body.model_override = args.modelOverride;

  const res = await openAuthed('/api/chat', { method: 'POST', body: JSON.stringify(body), signal: args.signal });
  if (!res.ok || !res.body) throw await failure(res);
  yield* readNdjson(res.body);
}

/** Re-attach to a session's run: replay events with seq > `after`, then tail live. */
export async function* streamChatRun(
  sessionId: string,
  after: number,
  signal?: AbortSignal,
): AsyncGenerator<RunStreamEvent> {
  const res = await openAuthed(`/api/chat/runs/${sessionId}/stream?after=${after}`, { method: 'GET', signal });
  if (!res.ok || !res.body) throw await failure(res);
  yield* readNdjson(res.body);
}

/**
 * Probe a session's run. `null` when it can't be asked (offline, not a
 * session the caller may write to) — callers treat that as "nothing running".
 */
export async function getChatRun(sessionId: string): Promise<ChatRunProbe | null> {
  try {
    const res = await api(`/api/chat/runs/${sessionId}`);
    if (!res.ok) return null;
    return (await res.json()) as ChatRunProbe;
  } catch {
    return null;
  }
}

/** Stop the generation server-side. False when nothing was running (or offline). */
export async function stopChatRun(sessionId: string): Promise<boolean> {
  try {
    const res = await api(`/api/chat/runs/${sessionId}/stop`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}
