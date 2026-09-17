import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getAuthUser, requireInternal } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';
import { resolveCoworker } from '../coworkers/identity.js';
import { ProfileAccessError } from '../profiles/access.js';

const coworkers = new Hono<AppEnv>()
  .use('*', requireInternal())
  .get('/', async (c) => {
    const user = getAuthUser(c);
    return c.json({ inboxes: await getDb().coworkers.listInboxes(user.id, user.role === 'super') });
  })
  .post('/open', async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.profile_id !== 'string' || body.profile_id.length > 160)
      return c.json({ error: 'profile_id is required' }, 400);
    try {
      const db = getDb();
      const { instance } = await resolveCoworker(user, body.profile_id, db);
      const saved = await db.coworkers.savedTopic(user.id, instance.id);
      const previous = saved?.active_session_id ? await db.sessions.getById(saved.active_session_id) : undefined;
      const sessionId =
        saved?.active_session_id === null
          ? null
          : previous && !['deleted', 'eval'].includes(previous.status)
            ? previous.id
            : ((await db.coworkers.listTopics(user.id, instance.id, { limit: 1 }))[0]?.id ?? null);
      await db.coworkers.rememberTopic(user.id, instance.id, sessionId);
      return c.json({ id: instance.id, profile_id: instance.profile_key, session_id: sessionId });
    } catch (error) {
      if (error instanceof ProfileAccessError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  })
  .get('/:id/topics', async (c) => {
    const user = getAuthUser(c),
      db = getDb();
    const inbox = (await db.coworkers.listInboxes(user.id, user.role === 'super')).find(
      (row) => row.id === c.req.param('id'),
    );
    if (!inbox) return c.json({ error: 'Coworker not found' }, 404);
    let before: { updated_at: string; id: string } | undefined;
    const cursor = c.req.query('cursor');
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (
          typeof value.id !== 'string' ||
          value.id.length > 160 ||
          typeof value.updated_at !== 'string' ||
          !Number.isFinite(Date.parse(value.updated_at))
        )
          throw new Error();
        before = value;
      } catch {
        return c.json({ error: 'Invalid cursor' }, 400);
      }
    }
    const rows = await db.coworkers.listTopics(user.id, inbox.id, {
      before,
      limit: 31,
      includeWorkflow: user.role === 'super',
    });
    const topics = rows.slice(0, 30),
      last = topics.at(-1);
    return c.json({
      inbox,
      topics,
      activities: await db.coworkers.inboxActivities(user.id, inbox.id, user.role === 'super'),
      next_cursor:
        rows.length > 30 && last
          ? Buffer.from(JSON.stringify({ updated_at: last.updated_at, id: last.id })).toString('base64url')
          : null,
    });
  })
  .post('/:id/visit', async (c) => {
    const user = getAuthUser(c),
      db = getDb();
    const body = await c.req.json().catch(() => null);
    if (!body || (body.session_id !== null && typeof body.session_id !== 'string'))
      return c.json({ error: 'session_id is required' }, 400);
    const inbox = (await db.coworkers.listInboxes(user.id)).find((row) => row.id === c.req.param('id'));
    if (!inbox) return c.json({ error: 'Coworker not found' }, 404);
    try {
      await db.coworkers.rememberTopic(user.id, inbox.id, body.session_id);
    } catch {
      return c.json({ error: 'Topic not found' }, 404);
    }
    return c.json({ ok: true });
  })
  .post('/topics/:id/read', async (c) => {
    const user = getAuthUser(c),
      db = getDb();
    const body = await c.req.json().catch(() => null);
    if (
      !Array.isArray(body?.message_ids) ||
      body.message_ids.length > 100 ||
      body.message_ids.some((id: unknown) => typeof id !== 'string' || id.length > 160)
    )
      return c.json({ error: 'message_ids must contain at most 100 IDs' }, 400);
    const session = await db.sessions.getById(c.req.param('id'));
    if (!session || session.user_id !== user.id || ['subagent', 'workflow'].includes(session.channel))
      return c.json({ error: 'Topic not found' }, 404);
    await db.coworkers.markMessagesRead(user.id, session.id, body.message_ids);
    return c.json({ ok: true });
  });
export default coworkers;
