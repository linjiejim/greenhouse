/**
 * Telegram channel worker — transport only.
 *
 * Long-polls getUpdates (no public ingress required — the key self-host win),
 * normalizes each update, hands it to the channel-agnostic dispatcher, and sends
 * the reply back (chunked, with a typing indicator while the agent works). The
 * poll cursor is persisted after every processed update so a restart resumes
 * without loss or reprocessing.
 */

import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { ChannelWorker, InboundMessage } from '../types.js';
import { IM_COMMANDS } from '../dispatch.js';
import { TelegramClient, parseTelegramUpdate, chunkMessage } from './client.js';

const LONG_POLL_TIMEOUT_SEC = 25;
const ERROR_BACKOFF_MS = 3_000;
const TYPING_INTERVAL_MS = 4_000;

type InboundHandler = (inbound: InboundMessage) => Promise<{ reply: string }>;

export class TelegramWorker implements ChannelWorker {
  readonly botId: string;
  private readonly client: TelegramClient;
  private readonly handle: InboundHandler;
  private offset: number;
  private running = false;
  private readonly abort = new AbortController();
  private loopPromise: Promise<void> | null = null;

  constructor(botId: string, token: string, startOffset: number, handle: InboundHandler) {
    this.botId = botId;
    this.client = new TelegramClient(token);
    this.handle = handle;
    this.offset = startOffset;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Advertise slash commands (best-effort); then spin the receive loop.
    this.client.setMyCommands([...IM_COMMANDS]).catch(() => {});
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loopPromise?.catch(() => {});
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.client.getUpdates(this.offset, LONG_POLL_TIMEOUT_SEC, this.abort.signal);
        for (const update of updates) {
          if (!this.running) break;
          this.offset = update.update_id + 1;
          await this.handleUpdate(update); // never throws
          await getDb().im.setPollOffset(this.botId, this.offset);
        }
      } catch (err) {
        if (!this.running || this.abort.signal.aborted) break;
        logger.error(`[IM] ❌ Telegram poll error (bot ${this.botId}): ${toErrorMessage(err)}`);
        await sleep(ERROR_BACKOFF_MS, this.abort.signal);
      }
    }
  }

  /** Process one update: normalize → dispatch → reply. Never throws. */
  private async handleUpdate(update: Parameters<typeof parseTelegramUpdate>[0]): Promise<void> {
    const inbound = parseTelegramUpdate(update);
    if (!inbound) return;

    const stopTyping = this.startTyping(inbound.extChatId);
    try {
      const { reply } = await this.handle(inbound);
      await this.sendReply(inbound.extChatId, reply);
    } catch (err) {
      logger.error(`[IM] ❌ Telegram handle error (bot ${this.botId}): ${toErrorMessage(err)}`);
      await this.client.sendMessage(inbound.extChatId, '⚠️ Something went wrong. Please try again.').catch(() => {});
    } finally {
      stopTyping();
    }
  }

  private async sendReply(chatId: string, reply: string): Promise<void> {
    for (const chunk of chunkMessage(reply)) {
      await this.client.sendMessage(chatId, chunk);
    }
  }

  /** Show a "typing…" indicator, refreshed until the returned stop() is called. */
  private startTyping(chatId: string): () => void {
    const ping = () => this.client.sendChatAction(chatId, 'typing').catch(() => {});
    ping();
    const timer = setInterval(ping, TYPING_INTERVAL_MS);
    return () => clearInterval(timer);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
