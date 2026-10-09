/**
 * Bots service — Bot identities, Bots conversations, members, shared notes,
 * "needs you" requests and the single-writer inbox (PostgreSQL).
 *
 * Every read and write is owner-scoped: callers pass the owning user id and a
 * row of another user is indistinguishable from a missing one. Ownership of
 * cross-references (a member Bot, a note author) is checked here, not left to
 * routes, so a forged id can never attach user Y's Bot to user X's
 * conversation.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { nowIso } from '@greenhouse/utils/date';
import { isUniqueViolation } from '@greenhouse/utils/error';

import type { Db, DbClient } from '../client.js';
import {
  bots,
  botVersions,
  botConversations,
  botConversationMembers,
  botSharedNotes,
  botRequests,
  botInbox,
  sessions,
  messages,
  users,
} from '../schema/index.js';
import type {
  BotRow,
  BotVersionRow,
  BotConversationRow,
  BotConversationMemberRow,
  BotSharedNoteRow,
  BotRequestRow,
  BotRequestKind,
  BotRequestStatus,
  BotInboxRow,
  BotInboxKind,
} from '../schema/bots.js';

/** Per-user cap on active Bots. */
/** The former custom-Agent cap (20) — Bots absorbed custom Agents, so the two limits merged. */
export const MAX_ACTIVE_BOTS_PER_USER = 20;
/** Bots in one conversation (the DM's owner included). */
export const MAX_BOTS_PER_CONVERSATION = 6;
/** Open shared notes in one conversation. */
export const MAX_OPEN_NOTES_PER_CONVERSATION = 50;
/** Where a conversation's unread count stops (`unreadCounts`; clients show "99+"). */
const UNREAD_COUNT_CAP = 99;

export class BotsDomainError extends Error {
  constructor(
    readonly code:
      | 'bot_not_found'
      | 'bot_limit'
      | 'bot_name_taken'
      | 'conversation_not_found'
      | 'member_limit'
      | 'already_member'
      | 'cannot_remove_owner'
      /** A retired group chat: readable history, no invites or removals. */
      | 'group_closed'
      | 'note_limit'
      | 'note_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'BotsDomainError';
  }
}

/**
 * Group chats were retired on 2026-10-09: the rows that exist stay readable
 * history, but nothing joins, leaves or speaks there any more. A Bot brings
 * others into its own DM instead (`team.add` / `team.ask`).
 */
function groupClosed(): BotsDomainError {
  return new BotsDomainError('group_closed', 'Group chats are retired — this conversation is read-only');
}

/** Normalised uniqueness key for a Bot name (full/half width and case folded). */
export function botNameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

function hexId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** The shape `hexId('bot')` produces — the one place other modules validate a Bot id against. */
export const BOT_ID_PATTERN = /^bot_[0-9a-f]{16}$/;

export function isBotId(value: unknown): value is string {
  return typeof value === 'string' && BOT_ID_PATTERN.test(value);
}

/** Failed applies after which an inbox row is quarantined (consumed, logged) instead of retried forever. */
export const INBOX_MAX_ATTEMPTS = 5;

/** Advisory-lock key namespace of a conversation's run (see `tryLockConversationRun`). */
const RUN_LOCK_PREFIX = 'bots-run:';

/** Governance metadata, versioned with the executable manifest (all optional). */
/** Provenance of the version a create / update appends. */
export interface BotVersionMeta {
  change_log?: string;
  created_by?: string | null;
}

export interface BotInput extends BotVersionMeta {
  user_id: string;
  name: string;
  role?: string;
  description?: string;
  instructions?: string;
  /** Avatar JSON text. */
  avatar?: string;
  model_id?: string | null;
  /** Tool ids the Bot may use; null / omitted = the owner's whole allowed set. */
  tools?: string[] | null;
  max_steps?: number | null;
  template_key?: string | null;
  /** The built-in Sprouty: not counted against MAX_ACTIVE_BOTS_PER_USER (every member has it). */
  builtIn?: boolean;
}

export interface BotUpdateInput extends BotVersionMeta {
  name?: string;
  role?: string;
  description?: string;
  instructions?: string;
  avatar?: string;
  model_id?: string | null;
  tools?: string[] | null;
  max_steps?: number | null;
}

/** The fields hashed into `bot_versions.manifest_hash`, in this fixed key order. */
type VersionManifest = Pick<
  BotVersionRow,
  'name' | 'role' | 'description' | 'instructions' | 'tools' | 'model_id' | 'max_steps' | 'avatar'
>;

function manifestHash(manifest: VersionManifest): string {
  // Built below in a fixed key order; arrays / objects are their persisted JSON
  // text, so the hash is deterministic across hosts.
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

/** The next manifest: the row's current values, then the edits. */
function manifestFrom(row: BotRow, updates: BotUpdateInput): VersionManifest {
  return {
    name: updates.name !== undefined ? updates.name.trim() : row.name,
    role: updates.role !== undefined ? updates.role.trim() : row.role,
    description: updates.description !== undefined ? updates.description.trim() : row.description,
    instructions: updates.instructions !== undefined ? updates.instructions.trim() : row.instructions,
    tools: updates.tools !== undefined ? (updates.tools === null ? null : JSON.stringify(updates.tools)) : row.tools,
    model_id: updates.model_id !== undefined ? updates.model_id : row.model_id,
    max_steps: updates.max_steps !== undefined ? updates.max_steps : row.max_steps,
    avatar: updates.avatar !== undefined ? updates.avatar : row.avatar,
  };
}

export interface ConversationWithMembers extends BotConversationRow {
  members: Array<BotConversationMemberRow>;
}

export interface NoteInput {
  title: string;
  body?: string;
  author_bot_id?: string | null;
  pinned?: boolean;
}

export interface RequestInput {
  user_id: string;
  session_id: string;
  bot_id?: string | null;
  kind: BotRequestKind;
  payload: Record<string, unknown>;
  expires_at?: string | null;
}

/** One transaction: enforce the per-member cap and name uniqueness, insert the row and its v1. */
function insertBotFactory(db: Db) {
  return async function insertBot(input: BotInput): Promise<BotRow> {
    return db.transaction(async (tx) => {
      const [count] = await tx
        .select({ n: sql<string>`count(*)` })
        .from(bots)
        .where(and(eq(bots.user_id, input.user_id), eq(bots.status, 'active')));
      if (!input.builtIn && Number(count?.n ?? 0) >= MAX_ACTIVE_BOTS_PER_USER) {
        throw new BotsDomainError('bot_limit', `At most ${MAX_ACTIVE_BOTS_PER_USER} active Bots per member`);
      }
      const nameKey = botNameKey(input.name);
      const [clash] = await tx
        .select({ id: bots.id })
        .from(bots)
        .where(and(eq(bots.user_id, input.user_id), eq(bots.status, 'active'), eq(bots.name_key, nameKey)))
        .limit(1);
      if (clash) throw new BotsDomainError('bot_name_taken', 'You already have a Bot with this name');

      const now = nowIso();
      const [row] = await tx
        .insert(bots)
        .values({
          id: hexId('bot'),
          user_id: input.user_id,
          name: input.name.trim(),
          name_key: nameKey,
          role: input.role?.trim() ?? '',
          description: input.description?.trim() ?? '',
          instructions: input.instructions?.trim() ?? '',
          avatar: input.avatar ?? '{}',
          model_id: input.model_id ?? null,
          tools: input.tools == null ? null : JSON.stringify(input.tools),
          max_steps: input.max_steps ?? null,
          template_key: input.template_key ?? null,
          status: 'active',
          current_version: 1,
          created_at: now,
          updated_at: now,
        })
        .returning();
      const manifest = manifestFrom(row!, input);
      await tx.insert(botVersions).values({
        bot_id: row!.id,
        version: 1,
        manifest_hash: manifestHash(manifest),
        change_log: input.change_log?.trim() || 'Initial version',
        ...manifest,
        created_by: input.created_by ?? input.user_id,
        created_at: now,
      });
      return row!;
    });
  };
}

export function createBotsService(db: Db) {
  const insertBot = insertBotFactory(db);

  async function assertOwnedBots(tx: Db, userId: string, botIds: string[]): Promise<BotRow[]> {
    if (botIds.length === 0) return [];
    const rows = await tx
      .select()
      .from(bots)
      .where(and(eq(bots.user_id, userId), eq(bots.status, 'active'), inArray(bots.id, botIds)));
    if (rows.length !== new Set(botIds).size) {
      throw new BotsDomainError('bot_not_found', 'One or more Bots do not exist');
    }
    return rows;
  }

  async function membersOf(tx: Db, sessionId: string): Promise<BotConversationMemberRow[]> {
    return await tx
      .select()
      .from(botConversationMembers)
      .where(eq(botConversationMembers.session_id, sessionId))
      .orderBy(asc(botConversationMembers.position), asc(botConversationMembers.id));
  }

  const service = {
    // ─── Bots ──────────────────────────────────────────

    async createBot(input: BotInput): Promise<BotRow> {
      try {
        return await insertBot(input);
      } catch (error) {
        // Two surfaces creating the same Bot at once (Chat and the Bots page both
        // bootstrapping Sprouty on a member's first visit) can both pass the
        // name pre-check; the unique index then decides. Report it as the same
        // domain error so callers retry by re-reading instead of surfacing a 500.
        if (isUniqueViolation(error)) {
          throw new BotsDomainError('bot_name_taken', 'You already have a Bot with this name');
        }
        throw error;
      }
    },

    /** Lookup without an owner (profile resolution of a shared Bot); callers enforce access. */
    async getBotById(botId: string): Promise<BotRow | undefined> {
      const [row] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
      return row;
    },

    /** The Bot a retired `custom:<id>` reference now means. */
    async getByLegacyCustomId(legacyId: number): Promise<BotRow | undefined> {
      const [row] = await db.select().from(bots).where(eq(bots.legacy_custom_id, legacyId)).limit(1);
      return row;
    },

    // ─── Versions ──────────────────────────────────────

    async getVersion(botId: string, version: number): Promise<BotVersionRow | undefined> {
      const [row] = await db
        .select()
        .from(botVersions)
        .where(and(eq(botVersions.bot_id, botId), eq(botVersions.version, version)))
        .limit(1);
      return row;
    },

    async getCurrentVersion(botId: string): Promise<BotVersionRow | undefined> {
      const bot = await service.getBotById(botId);
      return bot ? service.getVersion(botId, bot.current_version) : undefined;
    },

    async listVersions(botId: string): Promise<BotVersionRow[]> {
      return db.select().from(botVersions).where(eq(botVersions.bot_id, botId)).orderBy(desc(botVersions.version));
    },

    // ─── Sharing and governance ────────────────────────

    async listBots(userId: string, opts: { includeArchived?: boolean } = {}): Promise<BotRow[]> {
      const where = opts.includeArchived
        ? eq(bots.user_id, userId)
        : and(eq(bots.user_id, userId), eq(bots.status, 'active'));
      return await db.select().from(bots).where(where).orderBy(asc(bots.created_at));
    },

    /** Owner-scoped lookup; archived Bots are returned too (their messages keep a name). */
    async getBot(userId: string, botId: string): Promise<BotRow | undefined> {
      const [row] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.id, botId), eq(bots.user_id, userId)));
      return row;
    },

    async getBotsByIds(userId: string, botIds: string[]): Promise<BotRow[]> {
      if (botIds.length === 0) return [];
      return await db
        .select()
        .from(bots)
        .where(and(eq(bots.user_id, userId), inArray(bots.id, botIds)));
    },

    async updateBot(userId: string, botId: string, updates: BotUpdateInput): Promise<BotRow | undefined> {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(bots)
          .where(and(eq(bots.id, botId), eq(bots.user_id, userId), eq(bots.status, 'active')))
          .limit(1)
          .for('update');
        if (!existing) return undefined;
        const set: Partial<typeof bots.$inferInsert> = { updated_at: nowIso() };
        if (updates.name !== undefined) {
          const nameKey = botNameKey(updates.name);
          if (nameKey !== existing.name_key) {
            const [clash] = await tx
              .select({ id: bots.id })
              .from(bots)
              .where(and(eq(bots.user_id, userId), eq(bots.status, 'active'), eq(bots.name_key, nameKey)))
              .limit(1);
            if (clash) throw new BotsDomainError('bot_name_taken', 'You already have a Bot with this name');
          }
          set.name = updates.name.trim();
          set.name_key = nameKey;
        }
        const manifest = manifestFrom(existing, updates);
        const nextVersion = existing.current_version + 1;
        const now = nowIso();
        await tx.insert(botVersions).values({
          bot_id: botId,
          version: nextVersion,
          manifest_hash: manifestHash(manifest),
          change_log: updates.change_log?.trim() || `Version ${nextVersion}`,
          ...manifest,
          created_by: updates.created_by ?? existing.user_id,
          created_at: now,
        });
        set.role = manifest.role;
        set.description = manifest.description;
        set.instructions = manifest.instructions;
        set.avatar = manifest.avatar;
        set.model_id = manifest.model_id;
        set.tools = manifest.tools;
        set.max_steps = manifest.max_steps;
        set.current_version = nextVersion;
        set.updated_at = now;
        const [row] = await tx.update(bots).set(set).where(eq(bots.id, botId)).returning();
        return row;
      });
    },

    /**
     * Archive (the only "delete"): the Bot leaves every conversation it was a
     * guest in, its DM is kept readable (the owner row stays so history
     * renders), its private memories stay until the user deletes them. Its own
     * DM keeps no lead — nobody answers there unaddressed. (A retired group
     * chat it was in loses it from the roster the same way; nothing is
     * re-appointed there, nobody speaks in a closed group.)
     */
    async archiveBot(userId: string, botId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const now = nowIso();
        const [row] = await tx
          .update(bots)
          .set({ status: 'archived', updated_at: now })
          .where(and(eq(bots.id, botId), eq(bots.user_id, userId), eq(bots.status, 'active')))
          .returning({ id: bots.id });
        if (!row) return false;
        await tx
          .delete(botConversationMembers)
          .where(and(eq(botConversationMembers.bot_id, botId), sql`${botConversationMembers.role} <> 'owner'`));
        await tx
          .update(botConversations)
          .set({ lead_bot_id: null, updated_at: now })
          .where(and(eq(botConversations.user_id, userId), eq(botConversations.lead_bot_id, botId)));
        return true;
      });
    },

    async touchBot(botId: string): Promise<void> {
      await db.update(bots).set({ last_active_at: nowIso() }).where(eq(bots.id, botId));
    },

    // ─── Conversations ─────────────────────────────────

    /**
     * The Bot's direct conversation, created on first use. One per Bot
     * (uq_bot_conversations_owner_bot); the session is channel `bots`.
     */
    async ensureDirectConversation(userId: string, botId: string): Promise<ConversationWithMembers> {
      return db.transaction(async (tx) => {
        const [bot] = await assertOwnedBots(tx, userId, [botId]);
        const [existing] = await tx
          .select()
          .from(botConversations)
          .where(and(eq(botConversations.owner_bot_id, botId), eq(botConversations.user_id, userId)))
          .limit(1);
        if (existing) return { ...existing, members: await membersOf(tx, existing.session_id) };

        const now = nowIso();
        const sessionId = randomBytes(16).toString('hex');
        await tx.insert(sessions).values({
          id: sessionId,
          title: bot!.name,
          status: 'active',
          profile_id: 'sprouty',
          user_id: userId,
          channel: 'bots',
          metadata: '{}',
          created_at: now,
          updated_at: now,
        });
        const [conversation] = await tx
          .insert(botConversations)
          .values({
            session_id: sessionId,
            user_id: userId,
            kind: 'direct',
            owner_bot_id: botId,
            lead_bot_id: botId,
            last_activity_at: now,
            created_at: now,
            updated_at: now,
          })
          .returning();
        await tx.insert(botConversationMembers).values({
          session_id: sessionId,
          user_id: userId,
          bot_id: botId,
          role: 'owner',
          position: 0,
          added_by: 'user',
          joined_at: now,
        });
        return { ...conversation!, members: await membersOf(tx, sessionId) };
      });
    },

    async getConversation(userId: string, sessionId: string): Promise<ConversationWithMembers | undefined> {
      const [row] = await db
        .select()
        .from(botConversations)
        .where(and(eq(botConversations.session_id, sessionId), eq(botConversations.user_id, userId)));
      if (!row) return undefined;
      return { ...row, members: await membersOf(db, sessionId) };
    },

    /** Conversations by recent activity, with members — the Bots sidebar list. */
    async listConversations(userId: string, limit = 100): Promise<ConversationWithMembers[]> {
      const rows = await db
        .select()
        .from(botConversations)
        .where(eq(botConversations.user_id, userId))
        .orderBy(desc(botConversations.last_activity_at))
        .limit(limit);
      if (rows.length === 0) return [];
      const allMembers = await db
        .select()
        .from(botConversationMembers)
        .where(
          inArray(
            botConversationMembers.session_id,
            rows.map((r) => r.session_id),
          ),
        )
        .orderBy(asc(botConversationMembers.position), asc(botConversationMembers.id));
      const bySession = new Map<string, BotConversationMemberRow[]>();
      for (const m of allMembers) {
        const list = bySession.get(m.session_id) ?? [];
        list.push(m);
        bySession.set(m.session_id, list);
      }
      return rows.map((r) => ({ ...r, members: bySession.get(r.session_id) ?? [] }));
    },

    /** Latest message per conversation (preview + unread computation). */
    async latestMessages(
      sessionIds: string[],
    ): Promise<Map<string, { content: string; role: string; bot_id: string | null; created_at: string; seq: number }>> {
      const result = new Map<
        string,
        { content: string; role: string; bot_id: string | null; created_at: string; seq: number }
      >();
      if (sessionIds.length === 0) return result;
      const rows = await db.execute<{
        session_id: string;
        content: string;
        role: string;
        bot_id: string | null;
        created_at: string;
        seq: number;
      }>(sql`
        SELECT DISTINCT ON (session_id) session_id, content, role, bot_id, created_at::text AS created_at, seq
        FROM ${messages}
        WHERE session_id IN (${sql.join(
          sessionIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        ORDER BY session_id, seq DESC
      `);
      for (const row of rows as unknown as Array<{
        session_id: string;
        content: string;
        role: string;
        bot_id: string | null;
        created_at: string;
        seq: number;
      }>) {
        result.set(row.session_id, {
          content: row.content,
          role: row.role,
          bot_id: row.bot_id,
          created_at: row.created_at,
          seq: Number(row.seq),
        });
      }
      return result;
    },

    /**
     * Bot replies (`assistant` rows) after each conversation's `last_read_at`, capped at
     * UNREAD_COUNT_CAP — the badge number beside `attention: 'unread'`. Sessions with none
     * are absent from the map.
     */
    async unreadCounts(sessionIds: string[]): Promise<Map<string, number>> {
      const result = new Map<string, number>();
      if (sessionIds.length === 0) return result;
      const rows = await db.execute<{ session_id: string; n: number }>(sql`
        SELECT m.session_id, LEAST(COUNT(*), ${UNREAD_COUNT_CAP})::int AS n
        FROM ${messages} m
        JOIN ${botConversations} c ON c.session_id = m.session_id
        WHERE m.session_id IN (${sql.join(
          sessionIds.map((id) => sql`${id}`),
          sql`, `,
        )})
          AND m.role = 'assistant'
          AND (c.last_read_at IS NULL OR m.created_at > c.last_read_at)
        GROUP BY m.session_id
      `);
      for (const row of rows as unknown as Array<{ session_id: string; n: number }>) {
        result.set(row.session_id, Number(row.n));
      }
      return result;
    },

    /**
     * Invite one of the member's Bots into a DM as a guest (by the member, or
     * by a Bot's `team.add`: `addedBy` = `user` / `bot:<id>`). A retired group
     * chat takes no new members (`group_closed`).
     */
    async addMember(
      userId: string,
      sessionId: string,
      botId: string,
      addedBy: string,
    ): Promise<BotConversationMemberRow> {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select()
          .from(botConversations)
          .where(and(eq(botConversations.session_id, sessionId), eq(botConversations.user_id, userId)))
          .limit(1)
          .for('update');
        if (!conversation) throw new BotsDomainError('conversation_not_found', 'Conversation not found');
        if (conversation.kind === 'group') throw groupClosed();
        await assertOwnedBots(tx, userId, [botId]);
        const members = await membersOf(tx, sessionId);
        if (members.some((m) => m.bot_id === botId)) {
          throw new BotsDomainError('already_member', 'This Bot is already in the conversation');
        }
        if (members.length >= MAX_BOTS_PER_CONVERSATION) {
          throw new BotsDomainError('member_limit', `At most ${MAX_BOTS_PER_CONVERSATION} Bots per conversation`);
        }
        const now = nowIso();
        const [row] = await tx
          .insert(botConversationMembers)
          .values({
            session_id: sessionId,
            user_id: userId,
            bot_id: botId,
            role: 'guest',
            position: members.length,
            added_by: addedBy,
            joined_at: now,
          })
          .returning();
        await tx
          .update(botConversations)
          .set({ updated_at: now, last_activity_at: now })
          .where(eq(botConversations.session_id, sessionId));
        return row!;
      });
    },

    /** Take a guest out of a DM (its owner never leaves; a retired group chat is closed: `group_closed`). */
    async removeMember(userId: string, sessionId: string, botId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select()
          .from(botConversations)
          .where(and(eq(botConversations.session_id, sessionId), eq(botConversations.user_id, userId)))
          .limit(1)
          .for('update');
        if (!conversation) throw new BotsDomainError('conversation_not_found', 'Conversation not found');
        if (conversation.kind === 'group') throw groupClosed();
        const members = await membersOf(tx, sessionId);
        const target = members.find((m) => m.bot_id === botId);
        if (!target) return false;
        if (target.role === 'owner') {
          throw new BotsDomainError('cannot_remove_owner', 'A Bot cannot leave its own direct conversation');
        }
        await tx.delete(botConversationMembers).where(eq(botConversationMembers.id, target.id));
        return true;
      });
    },

    async markRead(userId: string, sessionId: string): Promise<void> {
      await db
        .update(botConversations)
        .set({ last_read_at: nowIso() })
        .where(and(eq(botConversations.session_id, sessionId), eq(botConversations.user_id, userId)));
    },

    async touchActivity(sessionId: string): Promise<void> {
      const now = nowIso();
      await db
        .update(botConversations)
        .set({ last_activity_at: now, updated_at: now })
        .where(eq(botConversations.session_id, sessionId));
    },

    /**
     * Compare-and-set the rolling digest: only writes when the stored boundary
     * is still the one the summariser started from.
     */
    async setDigest(
      sessionId: string,
      expectedUptoSeq: number,
      digest: { text: string; upto_seq: number; upto_message_id: string | null },
    ): Promise<boolean> {
      const rows = await db
        .update(botConversations)
        .set({
          digest: digest.text,
          digest_upto_seq: digest.upto_seq,
          digest_upto_message_id: digest.upto_message_id,
          digest_updated_at: nowIso(),
        })
        .where(and(eq(botConversations.session_id, sessionId), eq(botConversations.digest_upto_seq, expectedUptoSeq)))
        .returning({ id: botConversations.session_id });
      return rows.length > 0;
    },

    async resetDigest(sessionId: string): Promise<void> {
      await db
        .update(botConversations)
        .set({ digest: '', digest_upto_seq: 0, digest_upto_message_id: null, digest_updated_at: nowIso() })
        .where(eq(botConversations.session_id, sessionId));
    },

    // ─── Shared notes ──────────────────────────────────

    async listNotes(sessionId: string, opts: { status?: 'open' | 'done' } = {}): Promise<BotSharedNoteRow[]> {
      const where = opts.status
        ? and(eq(botSharedNotes.session_id, sessionId), eq(botSharedNotes.status, opts.status))
        : eq(botSharedNotes.session_id, sessionId);
      return await db
        .select()
        .from(botSharedNotes)
        .where(where)
        .orderBy(desc(botSharedNotes.pinned), desc(botSharedNotes.updated_at));
    },

    async addNote(sessionId: string, input: NoteInput): Promise<BotSharedNoteRow> {
      return db.transaction(async (tx) => {
        const [count] = await tx
          .select({ n: sql<string>`count(*)` })
          .from(botSharedNotes)
          .where(and(eq(botSharedNotes.session_id, sessionId), eq(botSharedNotes.status, 'open')));
        if (Number(count?.n ?? 0) >= MAX_OPEN_NOTES_PER_CONVERSATION) {
          throw new BotsDomainError(
            'note_limit',
            `At most ${MAX_OPEN_NOTES_PER_CONVERSATION} open notes — resolve some first`,
          );
        }
        const now = nowIso();
        const [row] = await tx
          .insert(botSharedNotes)
          .values({
            session_id: sessionId,
            title: input.title.trim(),
            body: input.body?.trim() ?? '',
            author_bot_id: input.author_bot_id ?? null,
            pinned: input.pinned ?? false,
            status: 'open',
            created_at: now,
            updated_at: now,
          })
          .returning();
        return row!;
      });
    },

    async updateNote(
      sessionId: string,
      noteId: number,
      updates: { title?: string; body?: string; status?: 'open' | 'done'; pinned?: boolean },
    ): Promise<BotSharedNoteRow | undefined> {
      const set: Partial<typeof botSharedNotes.$inferInsert> = { updated_at: nowIso() };
      if (updates.title !== undefined) set.title = updates.title.trim();
      if (updates.body !== undefined) set.body = updates.body.trim();
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.pinned !== undefined) set.pinned = updates.pinned;
      const [row] = await db
        .update(botSharedNotes)
        .set(set)
        .where(and(eq(botSharedNotes.id, noteId), eq(botSharedNotes.session_id, sessionId)))
        .returning();
      return row;
    },

    async deleteNote(sessionId: string, noteId: number): Promise<boolean> {
      const rows = await db
        .delete(botSharedNotes)
        .where(and(eq(botSharedNotes.id, noteId), eq(botSharedNotes.session_id, sessionId)))
        .returning({ id: botSharedNotes.id });
      return rows.length > 0;
    },

    // ─── "Needs you" requests ──────────────────────────

    async createRequest(input: RequestInput): Promise<BotRequestRow> {
      const now = nowIso();
      const [row] = await db
        .insert(botRequests)
        .values({
          id: hexId('brq'),
          user_id: input.user_id,
          session_id: input.session_id,
          bot_id: input.bot_id ?? null,
          kind: input.kind,
          status: 'pending',
          payload: JSON.stringify(input.payload),
          expires_at: input.expires_at ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async getRequest(userId: string, requestId: string): Promise<BotRequestRow | undefined> {
      const [row] = await db
        .select()
        .from(botRequests)
        .where(and(eq(botRequests.id, requestId), eq(botRequests.user_id, userId)));
      return row;
    },

    async listRequests(
      userId: string,
      opts: { sessionId?: string; status?: BotRequestStatus; kinds?: BotRequestKind[] } = {},
    ): Promise<BotRequestRow[]> {
      const conditions = [eq(botRequests.user_id, userId)];
      if (opts.sessionId) conditions.push(eq(botRequests.session_id, opts.sessionId));
      if (opts.status) conditions.push(eq(botRequests.status, opts.status));
      if (opts.kinds?.length) conditions.push(inArray(botRequests.kind, opts.kinds));
      return await db
        .select()
        .from(botRequests)
        .where(and(...conditions))
        .orderBy(desc(botRequests.created_at));
    },

    /**
     * Settle a pending request exactly once. Returns the settled row, or
     * undefined when it was already settled (a double click, a race between
     * slots) — the caller must then do nothing.
     */
    async settleRequest(
      userId: string,
      requestId: string,
      status: Exclude<BotRequestStatus, 'pending'>,
      result?: Record<string, unknown>,
    ): Promise<BotRequestRow | undefined> {
      const [row] = await db
        .update(botRequests)
        .set({ status, result: result ? JSON.stringify(result) : null, updated_at: nowIso() })
        .where(and(eq(botRequests.id, requestId), eq(botRequests.user_id, userId), eq(botRequests.status, 'pending')))
        .returning();
      return row;
    },

    /** Expire pending requests whose deadline passed; returns the expired rows. */
    async expireDueRequests(now = nowIso()): Promise<BotRequestRow[]> {
      return await db
        .update(botRequests)
        .set({ status: 'expired', updated_at: now })
        .where(and(eq(botRequests.status, 'pending'), lt(botRequests.expires_at, now)))
        .returning();
    },

    async countPendingRequests(userId: string): Promise<number> {
      const [row] = await db
        .select({ n: sql<string>`count(*)` })
        .from(botRequests)
        .where(and(eq(botRequests.user_id, userId), eq(botRequests.status, 'pending')));
      return Number(row?.n ?? 0);
    },

    // ─── Inbox (single-writer queue) ───────────────────

    async enqueueInbox(sessionId: string, kind: BotInboxKind, payload: Record<string, unknown>): Promise<BotInboxRow> {
      const [row] = await db
        .insert(botInbox)
        .values({ session_id: sessionId, kind, payload: JSON.stringify(payload), created_at: nowIso() })
        .returning();
      return row!;
    },

    async listPendingInbox(sessionId: string): Promise<BotInboxRow[]> {
      return await db
        .select()
        .from(botInbox)
        .where(and(eq(botInbox.session_id, sessionId), isNull(botInbox.consumed_at)))
        .orderBy(asc(botInbox.id));
    },

    /**
     * Mark one inbox item consumed — called AFTER the item was applied
     * (claim-then-apply: every apply is idempotent through a stable message id,
     * so a crash between the two re-applies harmlessly). False when another
     * drainer already consumed it.
     */
    async consumeInbox(id: number): Promise<boolean> {
      const rows = await db
        .update(botInbox)
        .set({ consumed_at: nowIso() })
        .where(and(eq(botInbox.id, id), isNull(botInbox.consumed_at)))
        .returning({ id: botInbox.id });
      return rows.length > 0;
    },

    /**
     * Count one failed apply of a pending item; returns the attempts so far.
     * The count lives in the payload (`_attempts`, `_last_error`) so it is
     * durable across slots and restarts — and it only grows while the database
     * accepts writes, so an outage never quarantines healthy items.
     */
    async recordInboxFailure(id: number, error: string): Promise<number> {
      const [row] = await db
        .select({ payload: botInbox.payload })
        .from(botInbox)
        .where(and(eq(botInbox.id, id), isNull(botInbox.consumed_at)));
      if (!row) return 0;
      let parsed: Record<string, unknown> = {};
      try {
        const value: unknown = JSON.parse(row.payload);
        if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
      } catch {
        // A malformed payload is quarantined by the caller; count from zero.
      }
      const attempts = (typeof parsed._attempts === 'number' ? parsed._attempts : 0) + 1;
      await db
        .update(botInbox)
        .set({ payload: JSON.stringify({ ...parsed, _attempts: attempts, _last_error: error.slice(0, 300) }) })
        .where(and(eq(botInbox.id, id), isNull(botInbox.consumed_at)));
      return attempts;
    },

    /** Take a poison item out of the queue for good (consumed without being applied; the row stays for forensics). */
    async quarantineInbox(id: number): Promise<boolean> {
      return service.consumeInbox(id);
    },

    /**
     * Sessions with undrained inbox items (the idle sweeper's work list),
     * oldest pending work first. Conversations whose owner may not run Bots
     * (suspended, mid-reset, demoted) are left out: their items stay queued —
     * answered once the owner is active again — without taking sweep slots.
     */
    async listSessionsWithPendingInbox(limit = 50): Promise<string[]> {
      const rows = await db
        .select({ session_id: botInbox.session_id })
        .from(botInbox)
        .innerJoin(sessions, eq(sessions.id, botInbox.session_id))
        .innerJoin(users, eq(users.id, sessions.user_id))
        .where(and(isNull(botInbox.consumed_at), eq(users.status, 'active'), inArray(users.role, ['team', 'super'])))
        .groupBy(botInbox.session_id)
        .orderBy(sql`min(${botInbox.id}) asc`)
        .limit(limit);
      return rows.map((r) => r.session_id);
    },

    /**
     * Cross-process ownership of a conversation's run (blue/green slots both
     * run the inbox sweeper). A session-level advisory lock, held on ONE
     * reserved connection per process for every run this process owns: it
     * costs a single pooled connection however many runs are live (handed back
     * to the pool as soon as no run is held, so shutdown never waits on it),
     * and the database releases the locks by itself if the process dies.
     * Within a process the ChatRun registry already serialises runs, so a
     * second attempt for a key this process holds is refused, not stacked.
     *
     * Throws when the lock cannot be checked (the caller does not start a
     * run). If the reserved connection fails, its locks go with it; the
     * transcript's tail CAS is then the remaining guard.
     */
    tryLockConversationRun(sessionId: string): Promise<boolean> {
      return serialLock(async () => {
        if (heldRunLocks.has(sessionId)) return false;
        const conn = await lockConnection();
        if (!conn) return true; // no raw client (mock / transaction provider): in-process exclusion only
        try {
          const [row] = await conn<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_lock(hashtextextended(${RUN_LOCK_PREFIX + sessionId}, 0)) AS locked`;
          if (!row?.locked) {
            releaseIfIdle();
            return false;
          }
          heldRunLocks.add(sessionId);
          return true;
        } catch (error) {
          dropLockConnection();
          throw error;
        }
      });
    },

    /** Release `tryLockConversationRun` (idempotent; a lost connection already released it). */
    unlockConversationRun(sessionId: string): Promise<void> {
      return serialLock(async () => {
        if (!heldRunLocks.delete(sessionId) || !reserved) return;
        try {
          await reserved`SELECT pg_advisory_unlock(hashtextextended(${RUN_LOCK_PREFIX + sessionId}, 0))`;
        } catch {
          dropLockConnection();
          return;
        }
        releaseIfIdle();
      });
    },
  };

  // ── The run-lock connection (see tryLockConversationRun) ──
  // Every lock operation is serialised, so the connection is never handed back
  // while another operation is about to use it.
  type ReservedSql = Awaited<ReturnType<DbClient['client']['reserve']>>;
  const heldRunLocks = new Set<string>();
  let reserved: ReservedSql | null = null;
  let lockOps: Promise<unknown> = Promise.resolve();
  function serialLock<T>(op: () => Promise<T>): Promise<T> {
    const next = lockOps.then(op, op);
    lockOps = next.catch(() => undefined);
    return next;
  }
  async function lockConnection(): Promise<ReservedSql | null> {
    if (reserved) return reserved;
    // A transaction-scoped provider (integration tests) has no pool to reserve from.
    if ((db as unknown) instanceof PgTransaction) return null;
    const client = (db as unknown as { $client?: DbClient['client'] }).$client;
    if (!client || typeof client.reserve !== 'function') return null;
    reserved = await client.reserve();
    return reserved;
  }
  /** No run held: the connection (now without locks) goes back to the pool. */
  function releaseIfIdle(): void {
    if (heldRunLocks.size > 0 || !reserved) return;
    const conn = reserved;
    reserved = null;
    conn.release();
  }
  /**
   * The connection failed: forget its locks. A connection that is still alive
   * goes back to the pool and the pool's idle timeout closes it, releasing
   * whatever it held.
   */
  function dropLockConnection(): void {
    const conn = reserved;
    reserved = null;
    heldRunLocks.clear();
    try {
      conn?.release();
    } catch {
      // Already gone.
    }
  }

  return service;
}

export type BotsService = ReturnType<typeof createBotsService>;
