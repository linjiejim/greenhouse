/**
 * Session routes — /api/sessions
 *
 * POST   /api/sessions                                — 创建新会话
 * GET    /api/sessions                                — 获取会话列表（支持status/limit/offset/include_eval筛选）
 * GET    /api/sessions/:id                             — 获取会话详情（含消息列表和token用量统计）
 * PATCH  /api/sessions/:id                             — 更新会话（status/rating/comment/title）
 * GET    /api/sessions/:id/context                      — 读取结构化会话上下文
 * PUT    /api/sessions/:id/context                      — 设置/清除结构化会话上下文（device/grower/plants...）
 * DELETE /api/sessions/:id                             — 删除会话
 * GET    /api/sessions/:id/shares                       — 获取会话的分享列表
 * DELETE /api/sessions/:id/shares                       — 移除会话的所有分享
 * DELETE /api/sessions/:id/shares/:shareId               — 移除单个分享
 * GET    /api/sessions/:id/messages/:msgId/eval        — 获取消息的缓存评估结果
 * GET    /api/sessions/:id/evals                       — 会话内每条消息的最新评估摘要（驱动评测按钮状态）
 * PATCH  /api/sessions/:id/messages/:msgId             — 编辑用户消息内容（同时删除后续消息）
 * POST   /api/sessions/:id/regenerate                  — 重新生成最后一条AI回复（删除旧回复）
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import type { AuthUser } from '../auth/middleware.js';
import type { SessionRow } from '../session.js';
import { generateSessionTitle } from '../llm/title.js';
import { normalizeProfileId, resolveProfileAsync } from '../profile.js';
import { parseSessionContext, readSessionContext, writeSessionContext } from '../session-context.js';
import type { AppEnv } from '../app-env.js';

// ─── Visibility Helpers ──────────────────────────────────

/** Check if user can READ (list/detail) a session. */
async function canAccessSession(user: AuthUser, session: SessionRow): Promise<boolean> {
  if (user.role === 'external') return false;
  if (user.role === 'super') return true;
  // Owner
  if (session.user_id === user.id) return true;
  // Shared with this user
  const sharedIds = await getDb().sessionShares.getSharedSessionIds(user.id);
  return sharedIds.includes(session.id);
}

/** Check if user can WRITE (update/delete) a session. */
function canWriteSession(user: AuthUser, session: SessionRow): boolean {
  if (user.role === 'external') return false;
  if (user.role === 'super') return true;
  // admin & member: only their own
  return session.user_id === user.id;
}

const sessions = new Hono<AppEnv>()
  /** GET /api/sessions/shareable-users — list active internal users for sharing */
  .get('/shareable-users', async (c) => {
    const authUser = getAuthUser(c);
    if (authUser.role === 'external') return c.json({ error: 'Forbidden' }, 403);

    const allUsers = await getDb().users.list();
    const users = allUsers
      .filter((u) => u.status === 'active' && u.id !== authUser.id)
      .map((u) => ({ id: u.id, nickname: u.nickname, email: u.email, role: u.role }));
    return c.json({ users });
  })
  /** POST /api/sessions — create a new session */
  .post('/', async (c) => {
    const authUser = getAuthUser(c);

    // External users cannot create sessions
    if (authUser.role === 'external') {
      return c.json({ error: 'External users cannot create sessions' }, 403);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      profile_id?: string;
      context?: unknown;
    };
    const requestedProfileId = normalizeProfileId(body.profile_id) || 'default';
    const profile = await resolveProfileAsync(requestedProfileId).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return new Error(message);
    });
    if (profile instanceof Error) {
      return c.json({ error: `Invalid profile: ${profile.message}` }, 400);
    }
    if (profile.access.level === 'hidden') {
      return c.json({ error: `Profile "${requestedProfileId}" cannot be used for cloud sessions` }, 403);
    }
    if (requestedProfileId.startsWith('custom:')) {
      const customId = parseInt(requestedProfileId.slice(7), 10);
      if (isNaN(customId)) return c.json({ error: 'Invalid custom profile ID' }, 400);
      const customRow = await getDb().customProfiles.getById(customId);
      if (!customRow) return c.json({ error: 'Custom profile not found' }, 404);
      if (customRow.user_id !== authUser.id && !customRow.is_shared && authUser.role !== 'super') {
        return c.json({ error: 'You do not have access to this custom profile' }, 403);
      }
    }

    let session = await getDb().sessions.create(body.title, requestedProfileId, authUser.id);

    // Optional structured session context (device/grower/plants...) at creation
    if (body.context !== undefined && body.context !== null) {
      // Web routes are the manual-configuration surface; app callers use /api/v1.
      const parsed = parseSessionContext(body.context, 'admin');
      if (!parsed.ok) return c.json({ error: `Invalid context: ${parsed.error}` }, 400);
      const updated = await getDb().sessions.update(session.id, {
        metadata: writeSessionContext(session.metadata, parsed.context),
      });
      if (updated) session = updated;
    }

    return c.json(session, 201);
  })
  /** GET /api/sessions/:id/context — read the structured session context */
  .get('/:id/context', async (c) => {
    const authUser = getAuthUser(c);
    const id = c.req.param('id');
    const session = await getDb().sessions.getById(id);
    if (!session || !(await canAccessSession(authUser, session))) {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json({ context: readSessionContext(session.metadata) });
  })
  /** PUT /api/sessions/:id/context — set or clear (context: null) the structured session context */
  .put('/:id/context', async (c) => {
    const authUser = getAuthUser(c);
    const id = c.req.param('id');
    const session = await getDb().sessions.getById(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    if (!canWriteSession(authUser, session)) return c.json({ error: 'Forbidden' }, 403);

    const body = (await c.req.json().catch(() => ({}))) as { context?: unknown };

    if (body.context === null) {
      await getDb().sessions.update(id, { metadata: writeSessionContext(session.metadata, null) });
      return c.json({ context: null });
    }

    const parsed = parseSessionContext(body.context, 'admin');
    if (!parsed.ok) return c.json({ error: `Invalid context: ${parsed.error}` }, 400);

    await getDb().sessions.update(id, { metadata: writeSessionContext(session.metadata, parsed.context) });
    return c.json({ context: parsed.context });
  })
  /** GET /api/sessions — list sessions */
  .get('/', async (c) => {
    const authUser = getAuthUser(c);

    // External users have no session history
    if (authUser.role === 'external') {
      return c.json({ sessions: [] });
    }

    const status = c.req.query('status');
    const limit = parseInt(c.req.query('limit') ?? '200', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);
    const includeEval = c.req.query('include_eval') === '1';
    const tagId = c.req.query('tag_id') ? parseInt(c.req.query('tag_id')!, 10) : undefined;

    // super sees all; admin/member see only their own + shared sessions
    const userId = authUser.role === 'super' ? undefined : authUser.id;

    const list = await getDb().sessions.list({ status, limit, offset, includeEval, userId });

    // Sessions shared with the current user (shared_with = me OR __team__).
    // Computed for every role so we can flag "shared with me" rows consistently.
    const sharedSessionIds = await getDb().sessionShares.getSharedSessionIds(authUser.id);
    const sharedIdSet = new Set(sharedSessionIds);

    // For non-super users, also include sessions shared with them
    if (userId) {
      if (sharedSessionIds.length > 0) {
        const existingIds = new Set(list.map((s) => s.id));
        const missingIds = sharedSessionIds.filter((id) => !existingIds.has(id));
        if (missingIds.length > 0) {
          const sharedSessions = await Promise.all(missingIds.map((id) => getDb().sessions.getById(id)));
          for (const s of sharedSessions) {
            // Mirror the main query's filters: status match AND the
            // include_eval flag (otherwise shared eval sessions leak into
            // lists that explicitly excluded them).
            if (!s) continue;
            if (status ? s.status !== status : !includeEval && s.status === 'eval') continue;
            list.push(s);
          }
        }
        // Re-sort by updated_at desc
        list.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
      }
    }

    // Backfill pinned/grouped sessions that fell outside the recent window
    // (an old or shared session the user filed/pinned must still surface).
    // Mirrors the shared-session backfill above; access-checked inline so a
    // session un-shared after being organized (an orphan membership) drops out.
    const organizedIds = await getDb().sessionGroups.getOrganizedSessionIds(authUser.id);
    if (organizedIds.length > 0) {
      const existingIds = new Set(list.map((s) => s.id));
      const missingIds = organizedIds.filter((id) => !existingIds.has(id));
      if (missingIds.length > 0) {
        const fetched = await Promise.all(missingIds.map((id) => getDb().sessions.getById(id)));
        for (const s of fetched) {
          if (!s) continue;
          const accessible = authUser.role === 'super' || s.user_id === authUser.id || sharedIdSet.has(s.id);
          if (!accessible) continue;
          // Mirror the main query's status / eval-visibility filters.
          if (status ? s.status !== status : !includeEval && s.status === 'eval') continue;
          list.push(s);
        }
        list.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
      }
    }

    // Enrich with tags + group/pin membership + ownership flags.
    // is_owner: the current user created this session.
    // shared: this session was shared with the current user by someone else
    //         (a self-shared session — e.g. one you shared to __team__ — is not "shared with me").
    const sessionIds = list.map((s) => s.id);
    const [tagsMap, membershipMap] = await Promise.all([
      getDb().sessionTags.getTagsBySessionIds(sessionIds),
      getDb().sessionGroups.getMembershipsForUser(authUser.id, sessionIds),
    ]);
    const enriched = list.map((s) => {
      const m = membershipMap.get(s.id);
      return {
        ...s,
        is_owner: s.user_id === authUser.id,
        shared: sharedIdSet.has(s.id) && s.user_id !== authUser.id,
        tags: (tagsMap.get(s.id) || []).map((t) => ({ id: t.id, name: t.name, color: t.color })),
        group_id: m?.group_id ?? null,
        group_sort: m?.group_sort ?? 0,
        pinned: m?.pinned ?? false,
        pin_sort: m?.pin_sort ?? 0,
      };
    });

    // Filter by tag if requested
    const result = tagId ? enriched.filter((s) => s.tags.some((t) => t.id === tagId)) : enriched;

    return c.json({ sessions: result });
  })
  /** GET /api/sessions/:id — get session detail + messages */
  .get('/:id', async (c) => {
    const authUser = getAuthUser(c);
    const id = c.req.param('id');
    const session = await getDb().sessions.getById(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // Visibility check: super sees all, admin/member only their own, external nothing
    if (!(await canAccessSession(authUser, session))) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const isOwner = session.user_id === authUser.id;

    const [messages, usage, tags, shareRows] = await Promise.all([
      getDb().sessions.getMessages(id),
      getDb().sessions.getUsage(id),
      getDb().sessionTags.getSessionTags(id),
      getDb().sessionShares.getSharesForSession(id),
    ]);

    // Compute share_count: -1 = team-wide, 0 = not shared, N = N users
    let shareCount = 0;
    if (shareRows.length > 0) {
      const hasTeam = shareRows.some((s) => s.shared_with === '__team__');
      shareCount = hasTeam ? -1 : shareRows.filter((s) => s.shared_with !== '__team__').length;
    }

    const enrichedSession = {
      ...session,
      user_id: undefined, // strip internal field
      is_owner: isOwner,
      share_count: shareCount,
      tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    };

    // For non-owner viewers, include share context
    let shareInfo = undefined;
    if (!isOwner && shareRows.length > 0) {
      const relevantShare = shareRows.find((s) => s.shared_with === authUser.id || s.shared_with === '__team__');
      if (relevantShare) {
        const sharer = await getDb().users.getById(relevantShare.shared_by);
        shareInfo = {
          shared_by: relevantShare.shared_by,
          shared_by_nickname: sharer?.nickname || 'Unknown',
          message: relevantShare.message,
          created_at: relevantShare.created_at,
          total_viewers: shareCount,
        };
      }
    }

    return c.json({ session: enrichedSession, messages, usage, share_info: shareInfo });
  })
  /** PATCH /api/sessions/:id — update session (status, rating, comment, title) */
  .patch('/:id', async (c) => {
    const authUser = getAuthUser(c);
    const id = c.req.param('id');

    // Check existence first
    const existing = await getDb().sessions.getById(id);
    if (!existing) return c.json({ error: 'Session not found' }, 404);

    // Write permission check
    if (!canWriteSession(authUser, existing)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = (await c.req.json()) as {
      status?: string;
      rating?: number;
      comment?: string;
      title?: string;
      feedback?: string | null;
      metadata?: string;
    };
    const session = await getDb().sessions.update(id, body);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    return c.json(session);
  })
  /** DELETE /api/sessions/:id — hard delete session */
  .delete('/:id', async (c) => {
    const authUser = getAuthUser(c);
    const id = c.req.param('id');
    const session = await getDb().sessions.getById(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // Write permission check
    if (!canWriteSession(authUser, session)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await getDb().sessions.delete(id);
    return c.json({ ok: true });
  })
  /** PATCH /api/sessions/:id/messages/:msgId — edit a message content */
  .patch('/:id/messages/:msgId', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const msgId = c.req.param('msgId');
    const body = (await c.req.json()) as { content: string };

    if (!body.content?.trim()) return c.json({ error: 'Content required' }, 400);

    // Ownership check on session
    const session = await getDb().sessions.getById(sessionId);
    if (!session || !canWriteSession(authUser, session)) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const msg = await getDb().sessions.getMessageById(msgId);
    if (!msg || msg.session_id !== sessionId) return c.json({ error: 'Message not found' }, 404);
    if (msg.role !== 'user') return c.json({ error: 'Can only edit user messages' }, 400);

    // Delete all messages after this one (assistant response + any subsequent)
    await getDb().sessions.deleteMessagesAfterSeq(sessionId, msg.seq + 1);

    // Update message content
    await getDb().sessions.updateMessageContent(msgId, body.content.trim());
    await getDb().sessions.touch(sessionId);

    return c.json({ ok: true });
  })
  /** POST /api/sessions/:id/generate-title — regenerate session title via LLM */
  .post('/:id/generate-title', async (c) => {
    const authUser = getAuthUser(c);
    const id = c.req.param('id');
    const session = await getDb().sessions.getById(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    if (!canWriteSession(authUser, session)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Get first user message
    const messages = await getDb().sessions.getMessages(id);
    const firstUser = messages.find((m) => m.role === 'user');
    if (!firstUser) return c.json({ error: 'No user message found' }, 400);

    try {
      const title = await generateSessionTitle(firstUser.content);
      await getDb().sessions.updateTitle(id, title);
      return c.json({ title });
    } catch {
      return c.json({ error: 'Title generation failed' }, 500);
    }
  })
  /** POST /api/sessions/:id/regenerate — delete last assistant message so chat can re-generate */
  .post('/:id/regenerate', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const session = await getDb().sessions.getById(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // Write permission check
    if (!canWriteSession(authUser, session)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const messages = await getDb().sessions.getMessages(sessionId);
    if (messages.length === 0) return c.json({ error: 'No messages to regenerate' }, 400);

    // Find the last assistant message
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return c.json({ error: 'No assistant message to regenerate' }, 400);

    // Delete the last assistant message (and anything after it)
    await getDb().sessions.deleteMessagesAfterSeq(sessionId, lastAssistant.seq);
    await getDb().sessions.touch(sessionId);

    // Find the last user message (which will be re-sent)
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');

    return c.json({ ok: true, lastUserMessage: lastUser?.content || '' });
  })
  /** GET /api/sessions/:id/shares — get shares for a session */
  .get('/:id/shares', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const session = await getDb().sessions.getById(sessionId);
    if (!session || !(await canAccessSession(authUser, session))) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const shareRows = await getDb().sessionShares.getSharesForSession(sessionId);

    // Enrich with user nicknames
    const enriched = await Promise.all(
      shareRows.map(async (s) => {
        const sharer = await getDb().users.getById(s.shared_by);
        let sharedWithNickname = s.shared_with === '__team__' ? 'Entire Team' : 'Unknown';
        if (s.shared_with !== '__team__') {
          const target = await getDb().users.getById(s.shared_with);
          sharedWithNickname = target?.nickname || 'Unknown';
        }
        return {
          ...s,
          shared_by_nickname: sharer?.nickname || 'Unknown',
          shared_with_nickname: sharedWithNickname,
        };
      }),
    );

    return c.json({ shares: enriched });
  })
  /** DELETE /api/sessions/:id/shares — remove all shares for a session */
  .delete('/:id/shares', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const session = await getDb().sessions.getById(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // Only session owner or super can unshare
    if (!canWriteSession(authUser, session)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await getDb().sessionShares.deleteForSession(sessionId);
    return c.json({ ok: true });
  })
  /** DELETE /api/sessions/:id/shares/:shareId — remove a single share */
  .delete('/:id/shares/:shareId', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const shareId = parseInt(c.req.param('shareId'), 10);
    if (isNaN(shareId)) return c.json({ error: 'Invalid share id' }, 400);

    const session = await getDb().sessions.getById(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // Only session owner or super can unshare
    if (!canWriteSession(authUser, session)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await getDb().sessionShares.deleteOne(shareId);
    return c.json({ ok: true });
  })
  // ─── Session Tag Link Endpoints ──────────────────────────

  /** POST /api/sessions/:id/tags — add a tag to a session */
  .post('/:id/tags', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const session = await getDb().sessions.getById(sessionId);
    if (!session || !canWriteSession(authUser, session)) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const body = (await c.req.json()) as { tag_id?: number };
    if (!body.tag_id) return c.json({ error: 'tag_id required' }, 400);

    // Verify tag belongs to user
    const tag = await getDb().sessionTags.getById(body.tag_id);
    if (!tag || tag.user_id !== authUser.id) {
      return c.json({ error: 'Tag not found' }, 404);
    }

    // Check max 5 tags per session
    const existingTags = await getDb().sessionTags.getSessionTags(sessionId);
    if (existingTags.length >= 5) {
      return c.json({ error: 'Maximum 5 tags per session' }, 400);
    }

    await getDb().sessionTags.addTagToSession(sessionId, body.tag_id);
    return c.json({ ok: true });
  })
  /** DELETE /api/sessions/:id/tags/:tagId — remove a tag from a session */
  .delete('/:id/tags/:tagId', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const tagId = parseInt(c.req.param('tagId'), 10);
    if (isNaN(tagId)) return c.json({ error: 'Invalid tag ID' }, 400);

    const session = await getDb().sessions.getById(sessionId);
    if (!session || !canWriteSession(authUser, session)) {
      return c.json({ error: 'Session not found' }, 404);
    }

    await getDb().sessionTags.removeTagFromSession(sessionId, tagId);
    return c.json({ ok: true });
  })

  // ─── Session Group / Pin Membership Endpoints ────────────
  // Per-user organization: gated by canAccessSession (NOT canWriteSession) so a
  // session shared with me can be filed/pinned into my own private layout.

  /** PUT /api/sessions/:id/group — file into a folder (group_id: number) or remove (null). */
  .put('/:id/group', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const session = await getDb().sessions.getById(sessionId);
    if (!session || !(await canAccessSession(authUser, session))) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as { group_id?: number | null };
    const groupId = body.group_id == null ? null : Number(body.group_id);
    if (groupId !== null && isNaN(groupId)) return c.json({ error: 'Invalid group_id' }, 400);

    const ok = await getDb().sessionGroups.setSessionGroup(authUser.id, sessionId, groupId);
    if (!ok) return c.json({ error: 'Group not found' }, 404);
    return c.json({ ok: true });
  })
  /** POST /api/sessions/:id/pin — pin the session for the current user */
  .post('/:id/pin', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const session = await getDb().sessions.getById(sessionId);
    if (!session || !(await canAccessSession(authUser, session))) {
      return c.json({ error: 'Session not found' }, 404);
    }
    await getDb().sessionGroups.pin(authUser.id, sessionId);
    return c.json({ ok: true });
  })
  /** DELETE /api/sessions/:id/pin — unpin the session for the current user */
  .delete('/:id/pin', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const session = await getDb().sessions.getById(sessionId);
    if (!session || !(await canAccessSession(authUser, session))) {
      return c.json({ error: 'Session not found' }, 404);
    }
    await getDb().sessionGroups.unpin(authUser.id, sessionId);
    return c.json({ ok: true });
  });

export default sessions;
