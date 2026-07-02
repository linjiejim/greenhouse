/**
 * Chat state hook — one active conversation, streamed turn accumulation.
 *
 * Sessions are created lazily on the first send (channel 'browser') and the
 * stream is consumed via the shared handleStreamEvent dispatcher from
 * @greenhouse/types, mirroring how the web app accumulates buffers.
 */

import { useCallback, useRef, useState } from 'react';
import { handleStreamEvent } from '@greenhouse/ui/lib/stream-events';
import type { StreamingToolCall } from '@greenhouse/ui/components/chat/streaming-message-bubble';
import type { ToolCall } from '@greenhouse/ui/components/tool-call';
import { streamChat } from '../lib/chat';
import { createSession, getSessionMessages, type BrowserSession } from '../lib/sessions';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | null;
  toolCalls: ToolCall[];
}

export interface StreamingState {
  text: string;
  reasoning: string;
  toolCalls: StreamingToolCall[];
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function useChat(profileId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string, contextHint?: string) => {
      setError(null);
      setMessages((prev) => [...prev, { role: 'user', content: text, toolCalls: [] }]);

      let sid = sessionId;
      try {
        if (!sid) {
          const session = await createSession(profileId);
          sid = session.id;
          setSessionId(sid);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'session_create_failed');
        return;
      }

      const buffers: StreamingState = { text: '', reasoning: '', toolCalls: [] };
      const flush = () => setStreaming({ ...buffers, toolCalls: [...buffers.toolCalls] });
      const upsertCall = (id: string, patch: Partial<StreamingToolCall> & { name?: string }) => {
        const existing = buffers.toolCalls.find((tc) => tc.id === id);
        if (existing) Object.assign(existing, patch);
        else buffers.toolCalls.push({ id, name: patch.name ?? '', input: '', status: 'calling', ...patch });
      };

      const abort = new AbortController();
      abortRef.current = abort;
      setStreaming(buffers);

      try {
        for await (const event of streamChat({ sessionId: sid, message: text, contextHint, signal: abort.signal })) {
          handleStreamEvent(event, {
            onTextDelta: (t) => {
              buffers.text += t;
            },
            onReasoningDelta: (t) => {
              buffers.reasoning += t;
            },
            onToolCallStart: (id, toolName) => upsertCall(id, { name: toolName }),
            onToolCallDelta: (id, delta) => {
              const call = buffers.toolCalls.find((tc) => tc.id === id);
              if (call) call.input += delta;
            },
            onToolCall: (toolName, input, id) => {
              if (id) upsertCall(id, { name: toolName, input: JSON.stringify(input) });
            },
            onToolResult: (id, _toolName, output) => upsertCall(id, { output, status: 'done' }),
            onTitle: (t) => setTitle(t),
            onError: (message) => setError(message),
          });
          flush();
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          setError(err instanceof Error ? err.message : 'stream_failed');
        }
      } finally {
        abortRef.current = null;
        // Materialize whatever streamed (even on abort/error) into the list.
        if (buffers.text || buffers.toolCalls.length > 0 || buffers.reasoning) {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: buffers.text,
              reasoning: buffers.reasoning || null,
              toolCalls: buffers.toolCalls.map((tc) => ({
                name: tc.name,
                input: tryParseJson(tc.input),
                output: tc.output,
                status: 'done' as const,
              })),
            },
          ]);
        }
        setStreaming(null);
      }
    },
    [sessionId, profileId],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const newConversation = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStreaming(null);
    setSessionId(null);
    setTitle(null);
    setError(null);
  }, []);

  const loadSession = useCallback(async (session: BrowserSession) => {
    abortRef.current?.abort();
    setError(null);
    setStreaming(null);
    setSessionId(session.id);
    setTitle(session.title);
    const history = await getSessionMessages(session.id);
    setMessages(
      history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          reasoning: m.reasoning,
          toolCalls: m.toolCalls,
        })),
    );
  }, []);

  return { messages, streaming, sessionId, title, error, send, stop, newConversation, loadSession };
}
