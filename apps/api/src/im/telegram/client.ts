/**
 * Minimal Telegram Bot API client — dependency-free (native fetch).
 *
 * Only the calls the gateway needs: getMe, getUpdates (long-poll), sendMessage,
 * sendChatAction (typing), setMyCommands. A thin hand-rolled client keeps the
 * adapter self-contained and reviewable; no third-party SDK is pulled in.
 *
 * The API base is overridable via TELEGRAM_API_BASE (proxy / testing).
 */

import type { InboundMessage } from '../types.js';
import { TELEGRAM_MAX_MESSAGE } from '../types.js';

const API_BASE = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';

// ─── Wire types (only the fields we consume) ──────────────

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string; // 'private' | 'group' | 'supergroup' | 'channel'
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramCommand {
  command: string;
  description: string;
}

/** Raised when the Telegram API returns `ok: false` or a transport error. */
export class TelegramApiError extends Error {}

export class TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params ?? {}),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!data.ok) {
      throw new TelegramApiError(data.description || `Telegram ${method} failed (HTTP ${res.status})`);
    }
    return data.result as T;
  }

  /** Verify the token and return the bot account (used at registration time). */
  getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', undefined, signal);
  }

  /** Long-poll for updates. `offset` acks everything below it; `timeout` in seconds. */
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message'] },
      signal,
    );
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text }, signal);
  }

  async sendChatAction(chatId: string, action = 'typing', signal?: AbortSignal): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action }, signal);
  }

  async setMyCommands(commands: TelegramCommand[], signal?: AbortSignal): Promise<void> {
    await this.call('setMyCommands', { commands }, signal);
  }
}

// ─── Pure parsing (unit-tested independently of the client) ──

/**
 * Normalize a Telegram update into an `InboundMessage`, or null if it carries no
 * usable text message (e.g. a non-message update, or a message with no text).
 * A leading `/command@bot arg` is split into `command` (lowercased, bot-suffix
 * stripped) and `commandArg`.
 */
export function parseTelegramUpdate(update: TelegramUpdate): InboundMessage | null {
  const msg = update.message;
  if (!msg || typeof msg.text !== 'string') return null;
  const text = msg.text.trim();
  if (!text) return null;

  const displayName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username;

  let command: string | undefined;
  let commandArg: string | undefined;
  if (text.startsWith('/')) {
    const [head, ...rest] = text.slice(1).split(/\s+/);
    // A command may be addressed as /cmd@BotName in groups — strip the suffix.
    command = (head?.split('@')[0] ?? '').toLowerCase();
    const arg = rest.join(' ').trim();
    commandArg = arg.length > 0 ? arg : undefined;
  }

  return {
    channel: 'telegram',
    extUserId: String(msg.from?.id ?? msg.chat.id),
    extChatId: String(msg.chat.id),
    text,
    displayName: displayName ?? undefined,
    command,
    commandArg,
  };
}

/** Split a reply into Telegram-sized chunks, preferring line boundaries. */
export function chunkMessage(text: string, max = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    // Prefer to break at the last newline within the window, else hard-split.
    let cut = remaining.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
