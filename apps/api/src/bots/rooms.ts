/**
 * Rooms — several people, and the Agents they bring, in one conversation (spec
 * 20261011-agent-first-class P5, D42–D46). A room is a `bot_conversations` row of kind `room`
 * (channel `bots`, the same engine); its people are `conversation_participants`.
 *
 * GET    /api/rooms                          → { rooms: BotConversationSummary[] }
 * GET    /api/rooms/people                   → { people: { id, nickname, email }[] } (who can join one)
 * POST   /api/rooms                          { user_ids, title?, bot_ids? } → 201 { conversation }
 *                                            (two people, no title, no Agents: their private room,
 *                                            reused when it exists → 200)
 * PATCH  /api/rooms/:id                      { title } → { conversation }
 * POST   /api/rooms/:id/participants         { user_id } → { conversation }
 * DELETE /api/rooms/:id/participants/:userId → { ok, deleted } (yourself; or the owner removing someone)
 * POST   /api/rooms/:id/agents               { bot_id } → { conversation }
 * DELETE /api/rooms/:id/agents/:botId        → { ok } (who brought it, its owner, or the room's owner)
 *
 * Messages go through POST /api/chat (the room's session id: every message is queued and its
 * @-mentions answered in a run of its author's) and the transcript through
 * GET /api/bots/conversations/:id, like every Agent conversation. Only participants read a room
 * — super included (D46).
 */

import { Hono, type Context } from 'hono';
import {
  BotsDomainError,
  getDb,
  type BotRow,
  type ConversationWithMembers,
  type DatabaseProvider,
  type UserRow,
} from '@greenhouse/db';
import type { BotConversationSummary } from '@greenhouse/types/bots';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { chatRunRegistry } from '../chat/runs.js';
import { connectionManager } from '../ws/connection-manager.js';
import { botsLocale, copy } from './engine/copy.js';
import { forgetConversationAudience, pushToConversation } from './engine/fanout.js';
import { deliverToConversation } from './engine/index.js';
import { botsOwnerEligible } from './engine/run-slot.js';
import { mayAddress, offeredToEveryone, roomViewExtras } from './room-access.js';
import { conversationDetail, domainStatus, ownerContext, readJson } from './routes.js';
import { toConversationSummary } from './views.js';

const MAX_IDS = 50;

function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IDS || value.some((v) => typeof v !== 'string' || v.length > 64)) {
    return null;
  }
  return [...new Set(value as string[])];
}

/** A person who may be in a room: active, internal, with Agents on (they post through the engine). */
async function eligiblePerson(db: DatabaseProvider, userId: string): Promise<UserRow | null> {
  const user = await db.users.getById(userId);
  return user && (await botsOwnerEligible(db, user)) ? user : null;
}

async function nicknameOf(db: DatabaseProvider, userId: string): Promise<string> {
  const user = await db.users.getById(userId);
  return user?.nickname || user?.email || '?';
}

/** The room as this participant sees it, or null (not a room, or not theirs). */
async function roomFor(
  db: DatabaseProvider,
  userId: string,
  sessionId: string,
): Promise<ConversationWithMembers | null> {
  const conversation = await db.bots.getConversation(userId, sessionId);
  return conversation?.kind === 'room' ? conversation : null;
}

async function detailOf(db: DatabaseProvider, userId: string, sessionId: string) {
  const conversation = await db.bots.getConversation(userId, sessionId);
  if (!conversation) return null;
  const owner = await ownerContext(db, userId);
  return conversationDetail(db, userId, conversation, owner.locale);
}

async function detailResponse(c: Context<AppEnv>, db: DatabaseProvider, userId: string, sessionId: string) {
  const conversation = await detailOf(db, userId, sessionId);
  return conversation
    ? c.json({ conversation })
    : c.json({ error: 'Conversation not found', code: 'conversation_not_found' as const }, 404);
}

/** A line in the room, through the single writer; then everyone in it hears. */
async function announce(
  db: DatabaseProvider,
  sessionId: string,
  memberId: string,
  item: Parameters<typeof deliverToConversation>[1],
) {
  await deliverToConversation(sessionId, item);
  forgetConversationAudience(sessionId);
  await pushToConversation(sessionId, memberId, { type: 'bots:conversation', sessionId }, db);
}

/** Who may bring this Agent into a room with these people (D45), or why not. */
async function admitAgent(
  db: DatabaseProvider,
  adderId: string,
  botId: string,
  peopleIds: readonly string[],
): Promise<{ bot: BotRow } | { error: string; code: 'agent_not_found' | 'agent_not_shared'; status: 404 | 409 }> {
  const bot = await db.bots.getBotById(botId);
  if (!bot || !(await mayAddress(db, adderId, bot))) {
    return { error: 'Agent not found', code: 'agent_not_found', status: 404 };
  }
  if (bot.user_id !== adderId && !(await offeredToEveryone(db, bot, peopleIds))) {
    return {
      error: 'That Agent is not shared with everyone in this conversation',
      code: 'agent_not_shared',
      status: 409,
    };
  }
  return { bot };
}

/**
 * After someone joins: a public Agent another person brought stays only if the newcomer is in its
 * audience too (D45). Returns the Agents taken out.
 */
async function enforceAudience(db: DatabaseProvider, room: ConversationWithMembers, newcomerId: string) {
  const removed: BotRow[] = [];
  for (const member of room.members) {
    const bot = await db.bots.getBotById(member.bot_id);
    if (!bot || bot.user_id === member.user_id) continue; // an owner's own Agent stays with its owner
    if (await offeredToEveryone(db, bot, [newcomerId])) continue;
    if (await db.bots.removeRoomAgent(room.session_id, bot.id)) removed.push(bot);
  }
  return removed;
}

export function createRoomsRoutes() {
  return (
    new Hono<AppEnv>()
      // ── GET /api/rooms — the rooms I take part in ──
      .get('/', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const rooms = await db.bots.listConversations(user.id, 100, { kinds: ['room'] });
        const sessionIds = rooms.map((room) => room.session_id);
        const [latest, unread, pending] = await Promise.all([
          db.bots.latestMessages(sessionIds),
          db.bots.unreadCounts(sessionIds, user.id),
          db.bots.listRequests(user.id, { status: 'pending' }),
        ]);
        const summaries: BotConversationSummary[] = [];
        for (const room of rooms) {
          summaries.push(
            toConversationSummary(room, {
              lastMessage: latest.get(room.session_id) ?? null,
              pendingRequests: pending.filter((r) => r.session_id === room.session_id).length,
              unreadCount: unread.get(room.session_id) ?? 0,
              working: Boolean(chatRunRegistry.getActive(room.session_id)),
              room: await roomViewExtras(db, user.id, room),
            }),
          );
        }
        return c.json({ rooms: summaries });
      })

      // ── GET /api/rooms/people — who can be in a conversation with me (active, internal, Agents on) ──
      .get('/people', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const people: Array<{ id: string; nickname: string; email: string }> = [];
        for (const row of await db.users.list()) {
          if (row.id === user.id || row.status !== 'active' || (row.role !== 'team' && row.role !== 'super')) continue;
          if (!(await botsOwnerEligible(db, row))) continue;
          people.push({ id: row.id, nickname: row.nickname || row.email, email: row.email });
          if (people.length >= 500) break;
        }
        people.sort((a, b) => a.nickname.localeCompare(b.nickname));
        return c.json({ people });
      })

      // ── POST /api/rooms — a new room (or the two people's existing private one) ──
      .post('/', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const body = await readJson(c);
        const userIds = stringList(body.user_ids);
        const botIds = stringList(body.bot_ids);
        if (!userIds || !botIds)
          return c.json({ error: 'user_ids and bot_ids must be lists of ids', code: 'invalid' as const }, 400);
        const others = userIds.filter((id) => id !== user.id);
        if (others.length === 0)
          return c.json({ error: 'Add at least one other person', code: 'no_people' as const }, 400);
        if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
          return c.json({ error: 'title must be text', code: 'invalid' as const }, 400);
        }
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;
        for (const id of others) {
          if (!(await eligiblePerson(db, id))) {
            return c.json(
              {
                error: 'Only active members with Agents can be in a conversation',
                code: 'person_not_eligible' as const,
              },
              400,
            );
          }
        }
        // Two people, no title, no Agents: a private chat between them — one per pair.
        if (others.length === 1 && !title && botIds.length === 0) {
          const existing = await db.bots.findPrivateRoom(user.id, others[0]!);
          if (existing) return detailResponse(c, db, user.id, existing.session_id);
        }
        const people = [user.id, ...others];
        const admitted: BotRow[] = [];
        for (const botId of botIds) {
          const verdict = await admitAgent(db, user.id, botId, people);
          if ('error' in verdict) return c.json({ error: verdict.error, code: verdict.code }, verdict.status);
          admitted.push(verdict.bot);
        }
        try {
          const room = await db.bots.createRoom({ creatorId: user.id, participantIds: others, title });
          for (const bot of admitted) await db.bots.addRoomAgent(room.session_id, bot.id, user.id);
          for (const id of people)
            connectionManager.sendToUser(id, { type: 'bots:conversation', sessionId: room.session_id });
          return c.json({ conversation: await detailOf(db, user.id, room.session_id) }, 201);
        } catch (error) {
          if (error instanceof BotsDomainError)
            return c.json({ error: error.message, code: error.code }, domainStatus(error));
          throw error;
        }
      })

      // ── PATCH /api/rooms/:id — its title (anyone in it) ──
      .patch('/:id', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const room = await roomFor(db, user.id, c.req.param('id'));
        if (!room) return c.json({ error: 'Conversation not found', code: 'conversation_not_found' as const }, 404);
        const body = await readJson(c);
        if (body.title !== null && typeof body.title !== 'string')
          return c.json({ error: 'title must be text', code: 'invalid' as const }, 400);
        await db.bots.setRoomTitle(room.session_id, body.title as string | null);
        await pushToConversation(
          room.session_id,
          user.id,
          { type: 'bots:conversation', sessionId: room.session_id },
          db,
        );
        return detailResponse(c, db, user.id, room.session_id);
      })

      // ── POST /api/rooms/:id/participants — add a person (anyone in it) ──
      .post('/:id/participants', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const room = await roomFor(db, user.id, c.req.param('id'));
        if (!room) return c.json({ error: 'Conversation not found', code: 'conversation_not_found' as const }, 404);
        const body = await readJson(c);
        const userId = typeof body.user_id === 'string' ? body.user_id : '';
        const person = userId ? await eligiblePerson(db, userId) : null;
        if (!person)
          return c.json(
            { error: 'Only active members with Agents can be in a conversation', code: 'person_not_eligible' as const },
            400,
          );
        try {
          const outcome = await db.bots.addParticipant(room.session_id, person.id, user.id);
          if (outcome === 'added') {
            const locale = botsLocale((await db.users.getById(user.id))?.locale);
            const by = await nicknameOf(db, user.id);
            await announce(db, room.session_id, user.id, {
              kind: 'event',
              text: copy.personJoined(locale, person.nickname || person.email, by),
              event: { kind: 'person_joined', user_id: person.id, by: user.id },
            });
            for (const bot of await enforceAudience(db, room, person.id)) {
              await announce(db, room.session_id, user.id, {
                kind: 'event',
                text: copy.agentNotForEveryone(locale, bot.name),
                event: { kind: 'left', bot_id: bot.id },
                botId: bot.id,
              });
            }
          }
        } catch (error) {
          if (error instanceof BotsDomainError)
            return c.json({ error: error.message, code: error.code }, domainStatus(error));
          throw error;
        }
        return detailResponse(c, db, user.id, room.session_id);
      })

      // ── DELETE /api/rooms/:id/participants/:userId — leave, or (the owner) remove someone ──
      .delete('/:id/participants/:userId', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const room = await roomFor(db, user.id, c.req.param('id'));
        if (!room) return c.json({ error: 'Conversation not found', code: 'conversation_not_found' as const }, 404);
        const target = c.req.param('userId');
        if (target !== user.id && room.user_id !== user.id) {
          return c.json(
            { error: 'Only the conversation’s owner can remove someone else', code: 'not_allowed' as const },
            403,
          );
        }
        if (chatRunRegistry.getActive(room.session_id)?.userId === target) {
          return c.json({ error: 'Their Agent is answering right now — try again in a moment', code: 'busy' }, 409);
        }
        const locale = botsLocale((await db.users.getById(user.id))?.locale);
        const name = await nicknameOf(db, target);
        const names = new Map<string, string>();
        for (const member of room.members)
          names.set(member.bot_id, (await db.bots.getBotById(member.bot_id))?.name ?? '');
        const result = await db.bots.removeParticipant(room.session_id, target);
        if (!result.removed)
          return c.json({ error: 'Not in this conversation', code: 'not_participant' as const }, 404);
        if (!result.deleted) {
          // The one who stays keeps the room's owner key valid; the lines go through its writer.
          const memberId = (await db.sessions.getById(room.session_id))?.user_id ?? user.id;
          await announce(db, room.session_id, memberId, {
            kind: 'event',
            text: copy.personLeft(locale, name),
            event: { kind: 'person_left', user_id: target },
          });
          for (const botId of result.removedBotIds) {
            await announce(db, room.session_id, memberId, {
              kind: 'event',
              text: copy.agentLeftWithOwner(locale, names.get(botId) || botId),
              event: { kind: 'left', bot_id: botId },
              botId,
            });
          }
        }
        connectionManager.sendToUser(target, { type: 'bots:conversation', sessionId: room.session_id });
        return c.json({ ok: true as const, deleted: result.deleted });
      })

      // ── POST /api/rooms/:id/agents — bring one of my Agents, or a public one offered to everyone here ──
      .post('/:id/agents', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const room = await roomFor(db, user.id, c.req.param('id'));
        if (!room) return c.json({ error: 'Conversation not found', code: 'conversation_not_found' as const }, 404);
        const body = await readJson(c);
        const botId = typeof body.bot_id === 'string' ? body.bot_id : '';
        const people = ((await db.bots.listParticipants([room.session_id])).get(room.session_id) ?? []).map(
          (p) => p.user_id,
        );
        const verdict = await admitAgent(db, user.id, botId, people);
        if ('error' in verdict) return c.json({ error: verdict.error, code: verdict.code }, verdict.status);
        try {
          await db.bots.addRoomAgent(room.session_id, verdict.bot.id, user.id);
        } catch (error) {
          if (error instanceof BotsDomainError)
            return c.json({ error: error.message, code: error.code }, domainStatus(error));
          throw error;
        }
        const locale = botsLocale((await db.users.getById(user.id))?.locale);
        await announce(db, room.session_id, user.id, {
          kind: 'event',
          text: copy.joined(locale, verdict.bot.name),
          event: { kind: 'joined', bot_id: verdict.bot.id, by: 'user' },
          botId: verdict.bot.id,
        });
        return detailResponse(c, db, user.id, room.session_id);
      })

      // ── DELETE /api/rooms/:id/agents/:botId — who brought it, its owner, or the room's owner ──
      .delete('/:id/agents/:botId', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const room = await roomFor(db, user.id, c.req.param('id'));
        if (!room) return c.json({ error: 'Conversation not found', code: 'conversation_not_found' as const }, 404);
        const member = room.members.find((m) => m.bot_id === c.req.param('botId'));
        if (!member) return c.json({ error: 'Agent not found', code: 'agent_not_found' as const }, 404);
        const bot = await db.bots.getBotById(member.bot_id);
        if (member.user_id !== user.id && bot?.user_id !== user.id && room.user_id !== user.id) {
          return c.json(
            {
              error: 'Only who brought it, its owner or the conversation’s owner can remove it',
              code: 'not_allowed' as const,
            },
            403,
          );
        }
        await db.bots.removeRoomAgent(room.session_id, member.bot_id);
        const locale = botsLocale((await db.users.getById(user.id))?.locale);
        await announce(db, room.session_id, user.id, {
          kind: 'event',
          text: copy.left(locale, bot?.name ?? member.bot_id),
          event: { kind: 'left', bot_id: member.bot_id },
          botId: member.bot_id,
        });
        return c.json({ ok: true as const });
      })
  );
}
