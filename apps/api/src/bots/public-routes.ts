/**
 * Public Agents for members and administrators (spec 20261011-agent-first-class P4).
 *
 * GET  /api/agents                    — 我能用的公开 Agent（别人发布、受众包含我；不含我自己的）
 * POST /api/agents/:id/conversation   — 我和它的私聊（没有就建，带它的欢迎语）→ { conversation_id }
 *
 * GET  /api/admin/agents              — 全部公开 Agent（负责人、受众人数、是否暂停、使用者数）
 * POST /api/admin/agents/:id/pause    — 暂停（除负责人外谁都用不了；不读任何对话）
 * POST /api/admin/agents/:id/resume   — 恢复
 *
 * /api/agents 在 requireInternal + requireFeature('bots') 之后；/api/admin/* 只给 super。
 */

import { Hono } from 'hono';
import { getDb, type BotRow, type DatabaseProvider } from '@greenhouse/db';
import type { SharedBotView } from '@greenhouse/types/bots';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { connectionManager } from '../ws/connection-manager.js';
import { writeGreeting } from './engine/greeting.js';
import { isPublished, listPublicBotsFor, publicationOf, publicBotFor } from './public.js';
import { toSharedBotView } from './views.js';

async function ownerOf(db: DatabaseProvider, bot: BotRow): Promise<{ id: string; nickname: string }> {
  const owner = await db.users.getById(bot.user_id);
  return { id: bot.user_id, nickname: owner?.nickname || owner?.email || '' };
}

export function createAgentsDirectoryRoutes() {
  return (
    new Hono<AppEnv>()
      // ── GET /api/agents — the directory ──
      .get('/', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const dms = new Map<string, string>();
        for (const conversation of await db.bots.listConversations(user.id)) {
          if (conversation.kind === 'direct' && conversation.owner_bot_id) {
            dms.set(conversation.owner_bot_id, conversation.session_id);
          }
        }
        const agents: SharedBotView[] = [];
        for (const bot of await listPublicBotsFor(db, user.id)) {
          agents.push(toSharedBotView(bot, await ownerOf(db, bot), dms.get(bot.id) ?? null, true));
        }
        return c.json({ agents });
      })

      // ── POST /api/agents/:id/conversation — my DM with it ──
      .post('/:id/conversation', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await publicBotFor(db, user.id, c.req.param('id'));
        if (!bot) return c.json({ error: 'Agent not found' }, 404);
        const conversation = await db.bots.ensureDirectConversation(user.id, bot.id, { public: true });
        await writeGreeting(db, conversation.session_id, bot, undefined, user.id);
        connectionManager.sendToUser(user.id, { type: 'bots:conversation', sessionId: conversation.session_id });
        return c.json({ conversation_id: conversation.session_id }, 201);
      })
  );
}

export function createAdminAgentsRoutes() {
  return new Hono<AppEnv>()
    .get('/', async (c) => {
      const db = getDb();
      const rows = [];
      for (const bot of await db.bots.listPublicBots()) {
        const settings = publicationOf(bot);
        rows.push({
          id: bot.id,
          name: bot.name,
          owner: await ownerOf(db, bot),
          published_version: bot.published_version,
          available: isPublished(bot),
          paused: bot.public_paused,
          audience: settings.audience.everyone
            ? 'everyone'
            : `${settings.audience.user_ids.length} people, ${settings.audience.group_ids.length} groups`,
          users: await db.bots.countBotUsers(bot.id),
        });
      }
      return c.json({ agents: rows });
    })
    .post('/:id/pause', async (c) => {
      const row = await getDb().bots.setPublicPaused(c.req.param('id'), true);
      if (!row) return c.json({ error: 'Agent not found' }, 404);
      return c.json({ ok: true as const, paused: true });
    })
    .post('/:id/resume', async (c) => {
      const row = await getDb().bots.setPublicPaused(c.req.param('id'), false);
      if (!row) return c.json({ error: 'Agent not found' }, 404);
      return c.json({ ok: true as const, paused: false });
    });
}
