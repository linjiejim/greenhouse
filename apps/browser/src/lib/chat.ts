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
import { BROWSER_ACTION_DESCRIPTORS } from './browser-actions';

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
      // Advertise the browser automation actions every turn; the backend turns
      // them into tools whose execution round-trips back to this panel via
      // `local-tool-request` events (executed in lib/browser-tools.ts).
      client_actions: BROWSER_ACTION_DESCRIPTORS,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `http_${res.status}`);
  }
  yield* readNdjsonStream<StreamingEvent>(res.body.getReader());
}

/**
 * Post a browser-action execution result back to the server, resuming the
 * agent step that is paused inside the tool's execute().
 */
export async function postToolResult(
  sessionId: string,
  result: { toolCallId: string; output: unknown; error?: string },
): Promise<void> {
  await authFetch('/api/client-tools/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, ...result }),
  });
}
