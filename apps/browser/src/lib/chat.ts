/**
 * Chat client — NDJSON streaming against POST /api/chat (session mode).
 *
 * The extension always runs in session mode: the server stores history and
 * replays it, so each turn only carries the NEW user message plus an optional
 * `context_hint` (page URL/title/selection) that is injected per-request into
 * the prompt without polluting the stored conversation.
 */

import { readNdjsonStream } from '@greenhouse/ui/lib/stream-utils';
import type { StreamingEvent } from '@greenhouse/ui/lib/stream-events';
import { authFetch } from './auth';

export async function* streamChat(opts: {
  sessionId: string;
  message: string;
  contextHint?: string;
  signal?: AbortSignal;
}): AsyncGenerator<StreamingEvent> {
  const res = await authFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: opts.sessionId,
      messages: [{ role: 'user', content: opts.message }],
      ...(opts.contextHint ? { context_hint: opts.contextHint } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `http_${res.status}`);
  }
  yield* readNdjsonStream<StreamingEvent>(res.body.getReader());
}
