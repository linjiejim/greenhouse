/**
 * Session routes — /api/sessions
 *
 * POST   /api/sessions                                — 创建新会话
 * GET    /api/sessions                                — 获取会话列表（支持status/limit/offset/page_meta/scope/channel/exclude_channel筛选；每页最多 200）
 * GET    /api/sessions/:id                             — 获取会话详情（include_messages=0 可只取元数据）
 * GET    /api/sessions/:id/messages                    — 分页获取会话消息
 * POST   /api/sessions/:id/fork                        — 复制完整会话或复制到指定 Agent 回复
 * PATCH  /api/sessions/:id                             — 更新会话（status/title/metadata）
 * DELETE /api/sessions/:id                             — 删除会话
 * GET    /api/sessions/:id/shares                       — 获取会话的分享列表
 * DELETE /api/sessions/:id/shares                       — 移除会话的所有分享
 * DELETE /api/sessions/:id/shares/:shareId               — 移除单个分享
 * PATCH  /api/sessions/:id/messages/:msgId             — 编辑用户消息内容（同时删除后续消息）
 * POST   /api/sessions/:id/regenerate                  — 校验指定的末尾 AI 回复可重新生成
 * POST   /api/sessions/:id/pin                         — 置顶（当前用户私有）
 * DELETE /api/sessions/:id/pin                         — 取消置顶
 * POST   /api/sessions/pins/reorder                    — 调整当前用户置顶会话的顺序
 */

import { GREENHOUSE_CONFIG } from '../config/greenhouse-config.js';
import { Hono } from 'hono';
import { getDb, SessionActiveRuntimeError } from '@greenhouse/db';
import { SESSION_SCOPES, type SessionScope } from '@greenhouse/types/api';
import { getAuthUser } from '../auth/middleware.js';
import { generateSessionTitle } from '../llm/title.js';
import { resolveProfileAsync } from '../profiles/profile.js';
import { canAccessSession, canWriteSession } from '../sessions/access.js';
import { pinProfileIdForUser, ProfileAccessError } from '../profiles/access.js';
import { createOwnedSession, SessionCreationError } from '../sessions/creation.js';
import type { AppEnv } from '../app-env.js';
import { deleteObjectAtKey } from '../storage/uploads.js';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { chatRunRegistry } from '../chat/runs.js';
import { withOwnerNicknames } from '../user-display.js';

// ─── Visibility Helpers ──────────────────────────────────

/**
 * How many shared conversations the unscoped list folds in.
 *
 * Matches the service's own default page size. The `shared` scope is the
 * paginated way to read them all; this backfill only keeps the legacy combined
 * list from losing recently-shared rows.
 */
const SHARED_BACKFILL_LIMIT = 200;

/**
 * `undefined` = no scope asked for, `null` = asked for something unknown.
 *
 * Omitting the scope lists the caller's own sessions plus the ones shared with
 * them, for every role; a super reads other members' conversations only through
 * `team`. The client sidebar asks for `mine` explicitly. The vocabulary lives in
 * `@greenhouse/types/api` so the browser and the server can't drift.
 */
/** `exclude_channel=task,feishu` → the channel names, or null when one is malformed. */
function parseExcludedChannels(raw: string | undefined): string[] | null {
  if (raw === undefined) return [];
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length > 10 || names.some((name) => !/^[a-z0-9_-]{1,32}$/.test(name))) return null;
  return [...new Set(names)];
}

function parseSessionScope(raw: string | undefined): SessionScope | undefined | null {
  if (raw === undefined) return undefined;
  return (SESSION_SCOPES as readonly string[]).includes(raw) ? (raw as SessionScope) : null;
}

const sessions = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    if (
      !GREENHOUSE_CONFIG.conversations.sharing &&
      (/\/shares(?:\/|$)/.test(c.req.path) || c.req.path.endsWith('/shareable-users'))
    )
      return c.notFound();
    return next();
  })
  /** GET /api/sessions/shareable-users — list active internal users for sharing */
  .get('/shareable-users', async (c) => {
    const authUser = getAuthUser(c);

    const allUsers = await getDb().users.list();
    const users = allUsers
      .filter((u) => u.status === 'active' && (u.role === 'team' || u.role === 'super') && u.id !== authUser.id)
      .map((u) => ({ id: u.id, nickname: u.nickname, email: u.email, role: u.role }));
    return c.json({ users });
  })
  /** POST /api/sessions/pins/reorder — reorder the caller's pinned sessions */
  .post('/pins/reorder', async (c) => {
    const authUser = getAuthUser(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      updates?: Array<{ session_id?: unknown; sort_order?: unknown }>;
    };
    if (!Array.isArray(body.updates) || body.updates.length === 0) {
      return c.json({ error: 'Updates array required' }, 400);
    }
    const updates: Array<{ session_id: string; sort_order: number }> = [];
    for (const u of body.updates) {
      if (typeof u?.session_id !== 'string' || !Number.isInteger(u.sort_order)) {
        return c.json({ error: 'Each update needs a session_id and an integer sort_order' }, 400);
      }
      updates.push({ session_id: u.session_id, sort_order: u.sort_order as number });
    }
    // Scoped to the caller's own Pinned group, so foreign ids are no-ops.
    await getDb().sessionPins.reorder(authUser.id, updates);
    return c.json({ ok: true });
  })
  /** POST /api/sessions — create a new session */
  .post('/', async (c) => {
    const authUser = getAuthUser(c);

    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      profile_id?: string;
    };
    // Channels are server-assigned; a client-supplied one is ignored. (The browser
    // extension used to file its own `browser` conversations; it was removed in 1.5.)
    try {
      const session = await createOwnedSession(authUser, { title: body.title, profileId: body.profile_id });
      return c.json(session, 201);
    } catch (err) {
      if (err instanceof SessionCreationError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  })
  /** GET /api/sessions — list sessions */
  .get('/', async (c) => {
    const authUser = getAuthUser(c);

    const status = c.req.query('status');
    const rawLimit = c.req.query('limit');
    const rawOffset = c.req.query('offset');
    const requestedLimit = rawLimit === undefined ? 200 : Number(rawLimit);
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    if (
      rawLimit !== undefined &&
      (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1)
    ) {
      return c.json({ error: 'limit must be a positive integer' }, 400);
    }
    if (rawOffset !== undefined && (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset))) {
      return c.json({ error: 'offset must be a non-negative integer' }, 400);
    }
    const includePageMeta = c.req.query('page_meta') === '1';
    const limit = Math.min(requestedLimit, 200);
    // Sessions of the retired eval feature never list.
    const includeEval = false;
    const channel = c.req.query('channel');
    // `exclude_channel=task` is the sidebar's "Mine" (my conversations without
    // automation runs); `channel=task` is its "Scheduled" tab.
    const excludedChannels = parseExcludedChannels(c.req.query('exclude_channel'));
    if (excludedChannels === null) {
      return c.json({ error: 'exclude_channel must be a comma-separated list of channel names' }, 400);
    }

    const scope = parseSessionScope(c.req.query('scope'));
    if (scope === null) {
      return c.json({ error: `scope must be one of: ${SESSION_SCOPES.join(', ')}` }, 400);
    }
    // Fail closed rather than quietly returning an empty page — an empty list
    // would hide the caller's bug instead of naming it.
    if (scope === 'team' && authUser.role !== 'super') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Workflow node/reviewer sessions (Workflows were retired in v1.4) were
    // engine internals — they never belong in a user-facing session list. They
    // still open by id (read-only); `?channel=workflow` is the explicit back door.
    const listOpts = {
      status,
      limit: includePageMeta ? limit + 1 : limit,
      offset,
      includeEval,
      channel,
      excludeChannels: channel
        ? excludedChannels.length > 0
          ? excludedChannels
          : undefined
        : ['workflow', ...excludedChannels.filter((name) => name !== 'workflow')],
    };

    let baseList;
    if (scope === 'shared' && !GREENHOUSE_CONFIG.conversations.sharing) return c.json({ sessions: [] });
    if (scope === 'shared') {
      baseList = await getDb().sessions.listSharedWith(authUser.id, listOpts);
    } else if (scope === 'team') {
      baseList = await getDb().sessions.list({ ...listOpts, excludeUserId: authUser.id });
    } else {
      // 'mine' and the unscoped list are the caller's own sessions, whatever the role.
      baseList = await getDb().sessions.list({ ...listOpts, userId: authUser.id });
    }
    const hasMore = includePageMeta && baseList.length > limit;
    const list = includePageMeta ? baseList.slice(0, limit) : baseList;
    const consumedBaseRows = list.length;

    // Sessions shared with the current user (shared_with = me OR __team__).
    // Computed for every role so we can flag "shared with me" rows consistently.
    const sharedSessionIds = GREENHOUSE_CONFIG.conversations.sharing
      ? await getDb().sessionShares.getSharedSessionIds(authUser.id)
      : [];
    const sharedIdSet = new Set(sharedSessionIds);

    // Unscoped: fold in sessions shared with this user. `scope=mine` deliberately
    // skips this — shared conversations live in their own tab.
    if (scope === undefined && sharedSessionIds.length > 0) {
      const sharedRows = await getDb().sessions.listSharedWith(authUser.id, {
        status,
        includeEval,
        limit: SHARED_BACKFILL_LIMIT,
        ...(excludedChannels.length > 0 ? { excludeChannels: excludedChannels } : {}),
      });
      const existingIds = new Set(list.map((s) => s.id));
      for (const s of sharedRows) {
        if (!existingIds.has(s.id)) list.push(s);
      }
      // Re-sort by updated_at desc
      list.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
    }

    // Backfill pinned sessions that fell outside the recent window (an old or
    // shared session the user pinned must still surface). Pinning is an
    // explicit act, so it outranks the scope filter — but only where the Pinned
    // section is rendered ('mine' and the unscoped list). A channel-filtered
    // list is not the sidebar: it answers "my conversations on <channel>", so
    // it gets no backfill.
    const pinnedIds =
      scope === 'shared' || scope === 'team' || channel
        ? []
        : await getDb().sessionPins.getPinnedSessionIds(authUser.id);
    if (pinnedIds.length > 0) {
      const existingIds = new Set(list.map((s) => s.id));
      const missingIds = pinnedIds.filter((id) => !existingIds.has(id));
      if (missingIds.length > 0) {
        const fetched = await Promise.all(missingIds.map((id) => getDb().sessions.getById(id)));
        for (const s of fetched) {
          if (!s) continue;
          const accessible = authUser.role === 'super' || s.user_id === authUser.id || sharedIdSet.has(s.id);
          if (!accessible) continue;
          // Mirror the main query's status / eval-visibility / excluded-channel filters.
          if (status ? s.status !== status : !includeEval && s.status === 'eval') continue;
          if (excludedChannels.includes(s.channel)) continue;
          list.push(s);
        }
        list.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
      }
    }

    // Enrich with pin state + ownership flags.
    // is_owner: the current user created this session.
    // shared: this session was shared with the current user by someone else
    //         (a self-shared session — e.g. one you shared to __team__ — is not "shared with me").
    const pinSorts = await getDb().sessionPins.getPinSortsForUser(
      authUser.id,
      list.map((s) => s.id),
    );
    const enriched = list.map((s) => ({
      ...s,
      is_owner: s.user_id === authUser.id,
      shared: sharedIdSet.has(s.id) && s.user_id !== authUser.id,
      pinned: pinSorts.has(s.id),
      pin_sort: pinSorts.get(s.id) ?? 0,
    }));
    // Name the owner on rows the caller doesn't own.
    const result = await withOwnerNicknames(getDb(), enriched, authUser.id);

    if (includePageMeta) {
      return c.json({
        sessions: result,
        page: {
          has_more: hasMore,
          next_offset: offset + consumedBaseRows,
        },
      });
    }
    return c.json({ sessions: result });
  })
  /** GET /api/sessions/:id/messages — get an ascending cursor page of messages */
  .get('/:id/messages', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const session = await getDb().sessions.getById(sessionId);
    if (!session || !(await canAccessSession(authUser, session))) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const rawLimit = c.req.query('limit');
    const rawBeforeSeq = c.req.query('before_seq');
    let limit = 50;
    let beforeSeq: number | undefined;

    if (rawLimit !== undefined) {
      limit = Number(rawLimit);
      if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return c.json({ error: 'limit must be an integer between 1 and 100' }, 400);
      }
    }

    if (rawBeforeSeq !== undefined) {
      beforeSeq = Number(rawBeforeSeq);
      if (!/^\d+$/.test(rawBeforeSeq) || !Number.isSafeInteger(beforeSeq)) {
        return c.json({ error: 'before_seq must be a non-negative integer' }, 400);
      }
    }

    const page = await getDb().sessions.getMessagePage(sessionId, { limit, beforeSeq });
    return c.json(page);
  })
  /** GET /api/sessions/:id — get session detail + messages */
  .get('/:id', async (c) => {
    const authUser = getAuthUser(c);
    const id = c.req.param('id');
    const rawIncludeMessages = c.req.query('include_messages');
    if (rawIncludeMessages !== undefined && rawIncludeMessages !== '0' && rawIncludeMessages !== '1') {
      return c.json({ error: 'include_messages must be 0 or 1' }, 400);
    }
    const includeMessages = rawIncludeMessages !== '0';
    const session = await getDb().sessions.getById(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // Visibility check: super sees all; team users see owned or explicitly shared sessions.
    if (!(await canAccessSession(authUser, session))) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const isOwner = session.user_id === authUser.id;

    const [messages, usage, shareRows] = await Promise.all([
      includeMessages ? getDb().sessions.getMessages(id) : Promise.resolve([]),
      getDb().sessions.getUsage(id),
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
  /** POST /api/sessions/:id/fork — copy a readable conversation into an owned session */
  .post('/:id/fork', async (c) => {
    const authUser = getAuthUser(c);
    const sourceSessionId = c.req.param('id');
    const source = await getDb().sessions.getById(sourceSessionId);
    if (!source || !(await canAccessSession(authUser, source))) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (source.channel !== 'web') {
      return c.json({ error: 'Only regular chat sessions can be forked' }, 400);
    }

    let profileId: string;
    try {
      // Your own conversation keeps its pinned version; a conversation shared
      // with you forks onto the Agent's current version (an older one may never
      // have been shared with you).
      const ownSource = source.user_id === authUser.id;
      const reference = ownSource ? source.profile_id : source.profile_id?.replace(/^(custom:[^@]+)@\d+$/, '$1');
      profileId = await pinProfileIdForUser(authUser, reference, undefined, { existingPin: ownSource });
    } catch (err) {
      if (err instanceof ProfileAccessError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    const profile = await resolveProfileAsync(profileId).catch(() => null);
    if (!profile || profile.access.level === 'hidden') {
      return c.json({ error: 'The source Agent is no longer available' }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as { message_id?: string };
    let throughSeq: number | undefined;
    if (body.message_id) {
      const boundary = await getDb().sessions.getMessageById(body.message_id);
      if (!boundary || boundary.session_id !== sourceSessionId) {
        return c.json({ error: 'Message not found' }, 404);
      }
      if (boundary.role !== 'assistant') {
        return c.json({ error: 'A conversation can only be forked from an Agent reply' }, 400);
      }
      throughSeq = boundary.seq;
    }

    const fork = await getDb().sessions.fork({
      sourceSessionId,
      userId: authUser.id,
      throughSeq,
      sourceMessageId: body.message_id,
    });
    if (!fork) return c.json({ error: 'Session not found' }, 404);
    return c.json(fork, 201);
  })
  /** PATCH /api/sessions/:id — update session (status, title, metadata) */
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

    const body = (await c.req.json()) as { status?: unknown; title?: unknown; metadata?: unknown };
    const updates: { status?: string; title?: string; metadata?: Record<string, unknown> } = {};
    if (body.status !== undefined) {
      const userWritableStatuses = new Set(['active', 'archived', 'completed', 'deleted']);
      if (typeof body.status !== 'string' || !userWritableStatuses.has(body.status)) {
        return c.json({ error: 'Invalid session status' }, 400);
      }
      updates.status = body.status;
    }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string') return c.json({ error: 'Invalid title' }, 400);
      updates.title = body.title;
    }
    if (body.metadata !== undefined) {
      if (body.metadata === null || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
        return c.json({ error: 'metadata must be an object' }, 400);
      }
      updates.metadata = body.metadata as Record<string, unknown>;
    }
    const session = await getDb().sessions.update(id, updates);
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

    if (chatRunRegistry.getActive(id)) {
      return c.json({ error: 'Stop the active Chat run before deleting this session' }, 409);
    }
    const files = await getDb().chatFiles.listBySession(id);
    try {
      await getDb().sessions.delete(id);
    } catch (error) {
      if (error instanceof SessionActiveRuntimeError) return c.json({ error: error.message }, 409);
      throw error;
    }
    await Promise.all(
      files.map((file) =>
        deleteObjectAtKey(file.storage_key).catch((error) => {
          logger.warn(`[Chat files] object cleanup failed for ${file.storage_key}: ${toErrorMessage(error)}`);
        }),
      ),
    );
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

    const result = await getDb().sessions.editUserMessageAndTruncate(sessionId, msgId, body.content.trim());
    if (!result.ok) {
      if (result.reason === 'not_user') {
        return c.json({ error: 'Can only edit user messages' }, 400);
      }
      return c.json({ error: result.reason === 'session_not_found' ? 'Session not found' : 'Message not found' }, 404);
    }

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
      const title = await generateSessionTitle(firstUser.content, { userId: authUser.id, sessionId: id });
      await getDb().sessions.updateTitle(id, title);
      return c.json({ title });
    } catch {
      return c.json({ error: 'Title generation failed' }, 500);
    }
  })
  /** POST /api/sessions/:id/regenerate — validate the selected tail assistant without deleting it */
  .post('/:id/regenerate', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const session = await getDb().sessions.getById(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // Write permission check
    if (!canWriteSession(authUser, session)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = (await c.req.json().catch(() => null)) as {
      assistant_message_id?: unknown;
    } | null;
    if (typeof body?.assistant_message_id !== 'string' || body.assistant_message_id.trim() === '') {
      return c.json({ error: 'assistant_message_id is required' }, 400);
    }

    const result = await getDb().sessions.prepareRegeneration(sessionId, body.assistant_message_id.trim());
    if (!result.ok) {
      if (result.reason === 'session_not_found') {
        return c.json({ error: 'Session not found' }, 404);
      }
      return c.json({ error: 'Assistant message is no longer the latest message' }, 409);
    }

    return c.json({ ok: true, last_user: result.last_user });
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
    const shareId = c.req.param('shareId');

    const session = await getDb().sessions.getById(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // Only session owner or super can unshare
    if (!canWriteSession(authUser, session)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const deleted = await getDb().sessionShares.deleteOne(shareId, sessionId);
    if (!deleted) return c.json({ error: 'Share not found' }, 404);
    return c.json({ ok: true });
  })
  // ─── Pin Endpoints ───────────────────────────────────────
  // Per-user organization: gated by canAccessSession (NOT canWriteSession) so a
  // session shared with me can be pinned into my own private layout.

  /** POST /api/sessions/:id/pin — pin the session for the current user */
  .post('/:id/pin', async (c) => {
    const authUser = getAuthUser(c);
    const sessionId = c.req.param('id');
    const session = await getDb().sessions.getById(sessionId);
    if (!session || !(await canAccessSession(authUser, session))) {
      return c.json({ error: 'Session not found' }, 404);
    }
    await getDb().sessionPins.pin(authUser.id, sessionId);
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
    await getDb().sessionPins.unpin(authUser.id, sessionId);
    return c.json({ ok: true });
  });

export default sessions;
