/**
 * IM gateway (admin) routes — /api/admin/im
 *
 * GET    /api/admin/im/bots            — list all bots (never returns the token)
 * POST   /api/admin/im/bots            — register a bot (validates the token, stores it encrypted)
 * PUT    /api/admin/im/bots/:id        — update name / status / default profile
 * POST   /api/admin/im/bots/:id/rotate — replace the bot token
 * DELETE /api/admin/im/bots/:id        — delete a bot
 *
 * Super-only (mounted under the /api/admin/* requireSuper() guard in index.ts).
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { ImBotRow } from '@greenhouse/db';
import { randomDocId } from '@greenhouse/utils/id';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getAuthUser } from '../auth/middleware.js';
import { encryptToken, isEncryptionConfigured } from '../auth/crypto.js';
import { listProfileIds } from '../profile.js';
import { getImGateway } from '../im/gateway.js';
import { TelegramClient } from '../im/telegram/client.js';
import type { AppEnv } from '../app-env.js';

const SUPPORTED_CHANNELS = new Set(['telegram']);

/** Validate a Telegram token by calling getMe; returns the bot username or throws. */
async function verifyTelegramToken(token: string): Promise<string | null> {
  const me = await new TelegramClient(token).getMe();
  return me.username ?? null;
}

const adminImRoutes = new Hono<AppEnv>()
  // ─── GET /api/admin/im/bots ─────────────────────────────
  .get('/bots', async (c) => {
    const bots = await getDb().im.listBots();
    return c.json({ bots: bots.map(formatBot) });
  })
  // ─── POST /api/admin/im/bots ────────────────────────────
  .post('/bots', async (c) => {
    const user = getAuthUser(c);
    if (!isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not set — cannot store a bot token securely' }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      channel?: string;
      name?: string;
      token?: string;
      default_profile_id?: string;
    };
    const channel = body.channel ?? 'telegram';
    if (!SUPPORTED_CHANNELS.has(channel)) return c.json({ error: `Unsupported channel: ${channel}` }, 400);
    if (!body.name || !body.token) return c.json({ error: 'name and token are required' }, 400);

    const profileId = body.default_profile_id ?? 'default';
    if (!listProfileIds().includes(profileId)) return c.json({ error: `Unknown profile: ${profileId}` }, 400);

    // Validate the token against Telegram before persisting anything.
    let botUsername: string | null;
    try {
      botUsername = await verifyTelegramToken(body.token);
    } catch (err) {
      return c.json({ error: `Invalid bot token: ${toErrorMessage(err)}` }, 400);
    }

    const bot = await getDb().im.createBot({
      id: randomDocId('imbot'),
      channel: 'telegram',
      name: body.name,
      token_enc: encryptToken(body.token),
      bot_username: botUsername,
      default_profile_id: profileId,
      created_by: user.id,
    });

    await getImGateway()?.reloadBot(bot.id);
    return c.json({ bot: formatBot(bot) }, 201);
  })
  // ─── PUT /api/admin/im/bots/:id ─────────────────────────
  .put('/bots/:id', async (c) => {
    const id = c.req.param('id');
    const bot = await getDb().im.getBot(id);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      status?: 'active' | 'disabled';
      default_profile_id?: string;
    };
    if (body.default_profile_id && !listProfileIds().includes(body.default_profile_id)) {
      return c.json({ error: `Unknown profile: ${body.default_profile_id}` }, 400);
    }
    if (body.status && body.status !== 'active' && body.status !== 'disabled') {
      return c.json({ error: 'status must be "active" or "disabled"' }, 400);
    }

    const updated = await getDb().im.updateBot(id, {
      name: body.name,
      status: body.status,
      default_profile_id: body.default_profile_id,
    });
    await getImGateway()?.reloadBot(id);
    return c.json({ bot: formatBot(updated!) });
  })
  // ─── POST /api/admin/im/bots/:id/rotate ─────────────────
  .post('/bots/:id/rotate', async (c) => {
    const id = c.req.param('id');
    const bot = await getDb().im.getBot(id);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    if (!isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not set — cannot store a bot token securely' }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (!body.token) return c.json({ error: 'token is required' }, 400);

    let botUsername: string | null;
    try {
      botUsername = await verifyTelegramToken(body.token);
    } catch (err) {
      return c.json({ error: `Invalid bot token: ${toErrorMessage(err)}` }, 400);
    }

    const updated = await getDb().im.updateBot(id, { token_enc: encryptToken(body.token), bot_username: botUsername });
    await getImGateway()?.reloadBot(id);
    return c.json({ bot: formatBot(updated!) });
  })
  // ─── DELETE /api/admin/im/bots/:id ──────────────────────
  .delete('/bots/:id', async (c) => {
    const id = c.req.param('id');
    const bot = await getDb().im.getBot(id);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    await getDb().im.deleteBot(id);
    await getImGateway()?.reloadBot(id); // removes the now-orphaned worker
    return c.json({ ok: true, deleted: id });
  });

// ─── Formatter (never exposes token_enc) ─────────────────

function formatBot(bot: ImBotRow) {
  return {
    id: bot.id,
    channel: bot.channel,
    name: bot.name,
    bot_username: bot.bot_username,
    default_profile_id: bot.default_profile_id,
    status: bot.status,
    created_by: bot.created_by,
    created_at: bot.created_at,
    updated_at: bot.updated_at,
  };
}

export default adminImRoutes;
