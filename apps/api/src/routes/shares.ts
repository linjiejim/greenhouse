/**
 * Share routes — /api/shares
 *
 * GET    /api/shares              — 列出"分享给我的"记录列表（含会话标题和分享者信息）
 * GET    /api/shares/count        — 获取未读分享数
 * POST   /api/shares              — 分享会话给指定用户/团队
 * PATCH  /api/shares/:id/read     — 标记单条已读
 * POST   /api/shares/read-session — 标记某会话的所有分享已读
 * POST   /api/shares/read-all     — 标记当前用户所有分享已读
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import { connectionManager } from '../ws/connection-manager.js';
import type { AppEnv } from '../app-env.js';

const shares = new Hono<AppEnv>()
  /** GET /api/shares — list shares for current user */
  .get('/', async (c) => {
    const user = getAuthUser(c);
    if (user.role === 'external') return c.json({ error: 'Forbidden' }, 403);

    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    const list = await getDb().sessionShares.listForUser(user.id, { limit, offset });

    // Enrich with session title and sharer nickname
    const enriched = await Promise.all(
      list.map(async (s) => {
        const session = await getDb().sessions.getById(s.session_id);
        const sharer = await getDb().users.getById(s.shared_by);
        return {
          ...s,
          session_title: session?.title || 'Untitled',
          shared_by_nickname: sharer?.nickname || 'Unknown',
          // Use per-user read_at for correctness
          read_at: s.user_read_at ?? null,
        };
      }),
    );

    return c.json({ shares: enriched });
  })
  /** GET /api/shares/count — unread share count */
  .get('/count', async (c) => {
    const user = getAuthUser(c);
    if (user.role === 'external') return c.json({ error: 'Forbidden' }, 403);

    const count = await getDb().sessionShares.countUnread(user.id);
    return c.json({ count });
  })
  /** POST /api/shares — share a session with users/team */
  .post('/', async (c) => {
    const user = getAuthUser(c);
    if (user.role === 'external') return c.json({ error: 'Forbidden' }, 403);

    const body = (await c.req.json()) as {
      session_id?: string;
      user_ids?: string[];
      team?: boolean;
      message?: string;
    };

    if (!body.session_id) return c.json({ error: 'session_id required' }, 400);

    // Verify session exists and user has permission to share
    const session = await getDb().sessions.getById(body.session_id);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // Only session owner or super can share
    if (session.user_id !== user.id && user.role !== 'super') {
      return c.json({ error: 'Only session owner can share' }, 403);
    }

    const inputs: Array<{ session_id: string; shared_with: string; shared_by: string; message?: string }> = [];

    // Share with specific users
    if (body.user_ids?.length) {
      for (const uid of body.user_ids) {
        if (uid === user.id) continue; // Don't share with yourself
        inputs.push({
          session_id: body.session_id,
          shared_with: uid,
          shared_by: user.id,
          message: body.message,
        });
      }
    }

    // Share with entire team
    if (body.team) {
      inputs.push({
        session_id: body.session_id,
        shared_with: '__team__',
        shared_by: user.id,
        message: body.message,
      });
    }

    if (inputs.length === 0) {
      return c.json({ error: 'No recipients specified' }, 400);
    }

    await getDb().sessionShares.createMany(inputs);

    // Push share notifications via WebSocket (fire-and-forget)
    const sharerNickname = (await getDb().users.getById(user.id))?.nickname || 'Unknown';
    const sessionTitle = session.title || 'Untitled';

    if (body.team) {
      // Notify all connected internal users (except the sharer)
      const allUsers = await getDb().users.list();
      for (const u of allUsers) {
        if (u.id === user.id || u.status !== 'active') continue;
        connectionManager.sendToUser(u.id, {
          type: 'share:new',
          shareId: 0,
          sessionId: body.session_id,
          sessionTitle,
          sharedBy: user.id,
          sharedByNickname: sharerNickname,
          message: body.message,
        });
        pushShareCount(u.id);
      }
    } else if (body.user_ids?.length) {
      for (const uid of body.user_ids) {
        if (uid === user.id) continue;
        connectionManager.sendToUser(uid, {
          type: 'share:new',
          shareId: 0,
          sessionId: body.session_id,
          sessionTitle,
          sharedBy: user.id,
          sharedByNickname: sharerNickname,
          message: body.message,
        });
        pushShareCount(uid);
      }
    }

    return c.json({ ok: true });
  })
  /** PATCH /api/shares/:id/read — mark one share as read */
  .patch('/:id/read', async (c) => {
    const user = getAuthUser(c);
    if (user.role === 'external') return c.json({ error: 'Forbidden' }, 403);

    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    await getDb().sessionShares.markReadForUser(id, user.id);

    // Push updated unread count via WebSocket
    pushShareCount(user.id);

    return c.json({ ok: true });
  })
  /** POST /api/shares/read-session — mark all shares in a session as read */
  .post('/read-session', async (c) => {
    const user = getAuthUser(c);
    if (user.role === 'external') return c.json({ error: 'Forbidden' }, 403);

    const body = (await c.req.json()) as { session_id?: string };
    if (!body.session_id) return c.json({ error: 'session_id required' }, 400);

    await getDb().sessionShares.markAllReadInSession(user.id, body.session_id);

    // Push updated unread count via WebSocket
    pushShareCount(user.id);

    return c.json({ ok: true });
  })
  /** POST /api/shares/read-all — mark all of the current user's shares as read */
  .post('/read-all', async (c) => {
    const user = getAuthUser(c);
    if (user.role === 'external') return c.json({ error: 'Forbidden' }, 403);

    await getDb().sessionShares.markAllRead(user.id);

    // Push updated unread count via WebSocket
    pushShareCount(user.id);

    return c.json({ ok: true });
  });

/** Push updated unread share count to a user via WebSocket. */
function pushShareCount(userId: string): void {
  getDb()
    .sessionShares.countUnread(userId)
    .then((count) => {
      connectionManager.sendToUser(userId, { type: 'share:count', count });
    })
    .catch(() => {});
}

export default shares;
