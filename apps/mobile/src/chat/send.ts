/**
 * Send one message to the assistant, or attach to a reply already being written, and follow it
 * as it streams. `POST /api/chat` and `GET /api/chat/runs/:id/stream` answer NDJSON
 * (src/data/chat-stream.ts); Expo's fetch exposes the body as a stream, so each event reaches
 * `onEvent` as it arrives. Where the body cannot be streamed it is read whole at the end. Both
 * answer how the stream ended; src/data/conversation.ts re-reads the saved messages afterwards.
 *
 * Every turn declares the rich blocks this app draws (`rich_blocks`, src/markdown/rich.ts), so the
 * model is only taught what renders here; a station that does not read it yet ignores it, and
 * the blocks still render.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { api, seg, toResult } from '../api/client';
import { CONNECTION_TIMEOUT_MS, ConnectionTimeoutError } from '../api/connection-deadline';
import { NdjsonLines, type ChatEvent } from '../data/chat-stream';
import type { SentImage, StreamOutcome } from '../data/conversation';
import { MOBILE_RICH_BLOCKS } from '../markdown/rich';

export type SendOutcome = StreamOutcome;

export async function sendMessage(
  sessionId: string,
  content: string,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
  images: readonly SentImage[] = [],
): Promise<SendOutcome> {
  return stream(
    '/api/chat',
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({
        session_id: sessionId,
        messages: [{ role: 'user', content, ...(images.length ? { images } : {}) }],
        rich_blocks: MOBILE_RICH_BLOCKS,
      }),
    },
    onEvent,
  );
}

/** Attach to the reply being written for a session, replayed from its start. */
export function followRun(sessionId: string, onEvent: (event: ChatEvent) => void, signal?: AbortSignal): Promise<SendOutcome> {
  return stream(`/api/chat/runs/${seg(sessionId)}/stream`, { signal, headers: { Accept: 'application/x-ndjson' } }, onEvent);
}

async function stream(path: string, init: RequestInit, onEvent: (event: ChatEvent) => void): Promise<SendOutcome> {
  let res: Response;
  // the station has CONNECTION_TIMEOUT_MS to start answering; a station out of reach is offline
  // (the message waits in the outbox) instead of a send that hangs. The request is cancelled too,
  // so a slow one cannot still land after the message was queued; whether it reached the station
  // first is unknown (status 0), which the outbox checks before sending it again.
  const controller = new AbortController();
  const outer = init.signal;
  const cancel = () => controller.abort(outer?.reason);
  if (outer?.aborted) cancel();
  else outer?.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answered = api(path, { ...init, signal: controller.signal }, expoFetch as unknown as typeof fetch);
    res = await Promise.race([
      answered,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new ConnectionTimeoutError();
          controller.abort(error);
          reject(error);
        }, CONNECTION_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    return { ok: false, status: 0, code: 'network', message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const miss = await toResult<never>(res);
    return miss.ok ? { ok: false, status: res.status, code: 'internal', message: '' } : miss;
  }
  const lines = new NdjsonLines();
  let finished = false;
  const emit = (events: ChatEvent[]) => {
    for (const event of events) {
      if (event.type === 'finish') finished = true;
      onEvent(event);
    }
  };
  try {
    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        emit(lines.push(decoder.decode(value, { stream: true })));
      }
    } else {
      emit(lines.push(await res.text()));
    }
    emit(lines.flush());
  } catch {
    // the stream broke off; the reply may still be written on the server
    return { ok: true, finished: false };
  }
  return { ok: true, finished };
}
