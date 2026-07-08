/**
 * IM gateway — Telegram update parsing + reply chunking (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import { parseTelegramUpdate, chunkMessage, type TelegramUpdate } from '../../apps/api/src/im/telegram/client.js';

function update(text: string, opts?: { fromId?: number; chatId?: number }): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: opts?.fromId ?? 42, first_name: 'Alice', last_name: 'Ng', username: 'alice' },
      chat: { id: opts?.chatId ?? 42, type: 'private' },
      text,
    },
  };
}

describe('parseTelegramUpdate', () => {
  it('normalizes a plain text message', () => {
    const inbound = parseTelegramUpdate(update('hello there'));
    expect(inbound).toMatchObject({
      channel: 'telegram',
      extUserId: '42',
      extChatId: '42',
      text: 'hello there',
      displayName: 'Alice Ng',
    });
    expect(inbound?.command).toBeUndefined();
  });

  it('splits a slash command and its argument', () => {
    const inbound = parseTelegramUpdate(update('/start ABC123'));
    expect(inbound?.command).toBe('start');
    expect(inbound?.commandArg).toBe('ABC123');
  });

  it('strips a @BotName suffix and lowercases the command', () => {
    const inbound = parseTelegramUpdate(update('/HELP@GreenhouseBot'));
    expect(inbound?.command).toBe('help');
    expect(inbound?.commandArg).toBeUndefined();
  });

  it('uses the chat id for extChatId when it differs from the user id', () => {
    const inbound = parseTelegramUpdate(update('hi', { fromId: 7, chatId: -100 }));
    expect(inbound?.extUserId).toBe('7');
    expect(inbound?.extChatId).toBe('-100');
  });

  it('returns null for updates without a usable text message', () => {
    expect(parseTelegramUpdate({ update_id: 2 })).toBeNull();
    expect(parseTelegramUpdate(update('   '))).toBeNull();
  });
});

describe('chunkMessage', () => {
  it('returns a single chunk when under the limit', () => {
    expect(chunkMessage('short', 100)).toEqual(['short']);
  });

  it('splits oversized text and preserves all content', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkMessage(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
    // Rejoining recovers the original (newline boundaries are where we split).
    expect(chunks.join('\n')).toBe(text);
  });

  it('hard-splits a long unbroken run with no newline', () => {
    const chunks = chunkMessage('x'.repeat(95), 40);
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe('x'.repeat(95));
  });
});
