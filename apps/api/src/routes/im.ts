/**
 * IM gateway (user) routes — /api/im
 *
 * GET    /api/im/bots            — list connectable (active) bots
 * POST   /api/im/pair            — mint a one-time deep-link code for the caller
 * GET    /api/im/identities      — the caller's linked IM identities
 * DELETE /api/im/identities/:id  — unlink one of the caller's identities
 *
 * Mounted behind requireInternal() + requireFeature('im_gateway') (see index.ts).
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { ImBotRow, ImIdentityRow } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import { mintPairingCode, buildDeepLink } from '../im/pairing.js';
import type { AppEnv } from '../app-env.js';

const imRoutes = new Hono<AppEnv>()
  // ─── GET /api/im/bots — connectable bots ────────────────
  .get('/bots', async (c) => {
    const bots = await getDb().im.listActiveBots();
    return c.json({ bots: bots.map(publicBot) });
  })
  // ─── POST /api/im/pair — mint a pairing code ────────────
  .post('/pair', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json().catch(() => ({}))) as { bot_id?: string };
    if (!body.bot_id) return c.json({ error: 'bot_id is required' }, 400);

    const bot = await getDb().im.getBot(body.bot_id);
    if (!bot || bot.status !== 'active') return c.json({ error: 'Bot not found or disabled' }, 404);

    const { code, expiresAt } = await mintPairingCode(bot.id, user.id);
    return c.json({
      code,
      deep_link: buildDeepLink(bot.channel, bot.bot_username, code),
      expires_at: expiresAt,
      instructions: bot.bot_username
        ? `Open the link, then tap Start. Or in the bot send: /start ${code}`
        : `Send this to the bot: /start ${code}`,
    });
  })
  // ─── GET /api/im/identities — caller's links ────────────
  .get('/identities', async (c) => {
    const user = getAuthUser(c);
    const identities = await getDb().im.listIdentitiesByUser(user.id);
    return c.json({ identities: identities.map(publicIdentity) });
  })
  // ─── DELETE /api/im/identities/:id — unlink ─────────────
  .delete('/identities/:id', async (c) => {
    const user = getAuthUser(c);
    const id = c.req.param('id');
    const identity = await getDb().im.getIdentityById(id);
    if (!identity || identity.user_id !== user.id) return c.json({ error: 'Identity not found' }, 404);
    await getDb().im.deleteIdentity(id);
    return c.json({ ok: true, deleted: id });
  });

// ─── Formatters ──────────────────────────────────────────

function publicBot(bot: ImBotRow) {
  return { id: bot.id, channel: bot.channel, name: bot.name, bot_username: bot.bot_username };
}

function publicIdentity(identity: ImIdentityRow) {
  return {
    id: identity.id,
    channel: identity.channel,
    bot_id: identity.bot_id,
    ext_user_id: identity.ext_user_id,
    display_name: identity.display_name,
    created_at: identity.created_at,
  };
}

export default imRoutes;
