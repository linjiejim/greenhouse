/**
 * Chat client — NDJSON streaming against POST /api/chat (session mode).
 *
 * The extension always runs in session mode: the server stores history and
 * replays it, so each turn only carries the NEW user message plus an optional
 * `ambient_context` (the page's title, URL and selection) that the server adds
 * to that turn's prompt without storing it in the conversation. The panel's
 * browser actions and knowledge write-back ride along as Client Actions; the
 * server runs them back here through `local-tool-request` events (executed in
 * lib/browser-tools.ts / lib/knowledge-tools.ts). Body shape: lib/chat-request.ts.
 */

import { readNdjsonStream } from '@greenhouse/ui/lib/stream-utils';
import type { StreamingEvent } from '@greenhouse/ui/lib/stream-events';
import type { AmbientContextEnvelope } from '@greenhouse/types/agent-context';
import { CLIENT_ACTION_RESULT_PATH } from '@greenhouse/types/api';
import { authFetch } from './auth';
import { buildChatRequestBody } from './chat-request';

export async function* streamChat(opts: {
  sessionId: string;
  message: string;
  scopeId: string;
  ambientContext?: AmbientContextEnvelope;
  signal?: AbortSignal;
}): AsyncGenerator<StreamingEvent> {
  const res = await authFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildChatRequestBody(opts)),
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
  await authFetch(CLIENT_ACTION_RESULT_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, ...result }),
  });
}
