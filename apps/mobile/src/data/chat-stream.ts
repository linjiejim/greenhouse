/**
 * The assistant's reply stream. React-free (./chat-stream.test.ts). `POST /api/chat` answers
 * NDJSON — one JSON event per line (`text-delta`, `tool-call-start`, `tool-result`, `error`,
 * `finish`, `ping`…, packages/types/src/api.ts). `NdjsonLines` turns arbitrary chunks into events;
 * `applyEvent` folds them into what the conversation shows while the reply is written. A turn
 * succeeded only if `finish` arrived; the saved messages are re-read afterwards either way.
 */

export type ChatEvent = { type: string } & Record<string, unknown>;

/** Splits a byte-chunked NDJSON body into parsed events; a broken line is skipped. */
export class NdjsonLines {
  private rest = '';

  push(chunk: string): ChatEvent[] {
    this.rest += chunk;
    const lines = this.rest.split('\n');
    this.rest = lines.pop() ?? '';
    return lines.flatMap(parseLine);
  }

  /** The last line, when the body ended without a newline. */
  flush(): ChatEvent[] {
    const last = this.rest;
    this.rest = '';
    return parseLine(last);
  }
}

function parseLine(line: string): ChatEvent[] {
  const text = line.trim();
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
      ? [value as ChatEvent]
      : [];
  } catch {
    return [];
  }
}

export interface LiveReply {
  text: string;
  /** The tool being used right now, if any. */
  tool: string | null;
  finished: boolean;
  error: string | null;
  /** A title the server gave the conversation. */
  title: string | null;
}

export const EMPTY_REPLY: LiveReply = { text: '', tool: null, finished: false, error: null, title: null };

export function applyEvent(reply: LiveReply, event: ChatEvent): LiveReply {
  switch (event.type) {
    case 'text-delta':
      return typeof event.text === 'string' ? { ...reply, text: reply.text + event.text, tool: null } : reply;
    case 'tool-call-start':
    case 'tool-call':
      return typeof event.toolName === 'string' ? { ...reply, tool: event.toolName } : reply;
    case 'tool-result':
    case 'tool-call-end':
      return { ...reply, tool: null };
    case 'title':
      return typeof event.title === 'string' ? { ...reply, title: event.title } : reply;
    case 'error':
      return { ...reply, error: typeof event.error === 'string' && event.error ? event.error : 'error', tool: null };
    case 'finish':
      return { ...reply, finished: true, tool: null };
    default:
      return reply;
  }
}

/** The messages a conversation shows: the member's and the assistant's, with words in them. */
export function visibleMessages<T extends { role: string; content: string }>(messages: readonly T[]): T[] {
  return messages.filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim() !== '');
}
