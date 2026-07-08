/**
 * IM Gateway — manages one receive worker per active bot.
 *
 * Lifecycle mirrors the task scheduler: init once at startup, `start()` loads
 * active bots and spins a worker each, admin CRUD calls `reloadBot()` to
 * add/replace/remove a worker live, `stop()` tears everything down on shutdown.
 * Bot tokens are decrypted here (PROVIDER_TOKEN_ENCRYPTION_KEY) — if that key is
 * absent the gateway stays dormant rather than failing the whole server.
 */

import { getDb, type ImBotRow } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { decryptToken, isEncryptionConfigured } from '../auth/crypto.js';
import type { ToolRegistry } from '../agent.js';
import type { ChannelWorker, InboundMessage } from './types.js';
import { dispatchInbound } from './dispatch.js';
import { sweepExpiredPairingCodes } from './pairing.js';
import { TelegramWorker } from './telegram/worker.js';

const PAIRING_SWEEP_INTERVAL_MS = 60 * 60_000; // hourly

export class ImGateway {
  private readonly workers = new Map<string, ChannelWorker>();
  private readonly toolRegistry: ToolRegistry;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  /** Load active bots and start their workers. No-op (with a warning) if tokens can't be decrypted. */
  async start(): Promise<void> {
    if (!isEncryptionConfigured()) {
      logger.warn('[IM] Gateway disabled: PROVIDER_TOKEN_ENCRYPTION_KEY is not set (cannot decrypt bot tokens)');
      return;
    }
    const bots = await getDb().im.listActiveBots();
    for (const bot of bots) this.addWorker(bot);
    logger.info(`[IM] Gateway started with ${this.workers.size} active bot(s)`);

    this.sweepTimer = setInterval(() => {
      void sweepExpiredPairingCodes().catch(() => {});
    }, PAIRING_SWEEP_INTERVAL_MS);
  }

  /** Build + start a worker for one bot (best-effort; a bad token skips only that bot). */
  private addWorker(bot: ImBotRow): void {
    if (bot.channel !== 'telegram') {
      logger.warn(`[IM] Unsupported channel "${bot.channel}" for bot ${bot.id} — skipped`);
      return;
    }
    try {
      const token = decryptToken(bot.token_enc);
      const handle = (inbound: InboundMessage) => dispatchInbound(bot, inbound, { toolRegistry: this.toolRegistry });
      const worker = new TelegramWorker(bot.id, token, bot.poll_offset, handle);
      worker.start();
      this.workers.set(bot.id, worker);
      logger.info(`[IM] ▶ Telegram worker started (bot ${bot.id}, @${bot.bot_username ?? '?'})`);
    } catch (err) {
      logger.error(`[IM] ❌ Failed to start worker for bot ${bot.id}: ${toErrorMessage(err)}`);
    }
  }

  private async removeWorker(botId: string): Promise<void> {
    const worker = this.workers.get(botId);
    if (worker) {
      await worker.stop();
      this.workers.delete(botId);
      logger.info(`[IM] ⏹ Worker stopped (bot ${botId})`);
    }
  }

  /** React to an admin change: stop the old worker, start a fresh one if still active. */
  async reloadBot(botId: string): Promise<void> {
    await this.removeWorker(botId);
    if (!isEncryptionConfigured()) return;
    const bot = await getDb().im.getBot(botId);
    if (bot && bot.status === 'active') this.addWorker(bot);
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.all([...this.workers.keys()].map((id) => this.removeWorker(id)));
  }

  getStatus(): { activeBots: number; botIds: string[] } {
    return { activeBots: this.workers.size, botIds: [...this.workers.keys()] };
  }
}

// ─── Singleton ────────────────────────────────────────────

let _gateway: ImGateway | null = null;

export function initImGateway(toolRegistry: ToolRegistry): ImGateway {
  _gateway = new ImGateway(toolRegistry);
  return _gateway;
}

export function getImGateway(): ImGateway | null {
  return _gateway;
}
