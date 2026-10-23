/**
 * Send one message to the assistant and follow the reply as it is written. `POST /api/chat`
 * answers NDJSON (src/data/chat-stream.ts); Expo's fetch exposes the body as a stream, so each
 * event reaches `onEvent` as it arrives. Where the body cannot be streamed it is read whole at
 * the end. Answers how the turn ended; the caller re-reads the saved messages afterwards.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { api, toResult, type ApiMiss } from '../api/client';
import { NdjsonLines, type ChatEvent } from '../data/chat-stream';

export type SendOutcome = { ok: true; finished: boolean } | ApiMiss;

export async function sendMessage(
  sessionId: string,
  content: string,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<SendOutcome> {
  let res: Response;
  try {
    res = await api(
      '/api/chat',
      {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ session_id: sessionId, messages: [{ role: 'user', content }] }),
      },
      expoFetch as unknown as typeof fetch,
    );
  } catch (error) {
    return { ok: false, status: 0, code: 'network', message: error instanceof Error ? error.message : String(error) };
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
