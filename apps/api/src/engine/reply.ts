import type { ModelMessage } from 'ai';

/** Tool-step prose is model context, never a conversation reply. */
export function replyText(messages: ModelMessage[]): string {
  if (
    messages.some(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'tool-call'),
    )
  )
    return '';
  return messages
    .filter((message) => message.role === 'assistant')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => (part as { text: string }).text)
            .join(''),
    )
    .join('');
}

/** Wake-up text is private from the first token; member replies keep streaming in one row. */
export async function* replyParts<T extends { type: string; text?: string }>(
  parts: AsyncIterable<T>,
  wake: boolean,
): AsyncGenerator<T> {
  for await (const part of parts) {
    if (wake && part.type === 'text-delta') continue;
    yield part;
  }
}
