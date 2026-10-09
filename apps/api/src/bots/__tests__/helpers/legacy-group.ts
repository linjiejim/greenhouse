/**
 * A retired Bots group chat, inserted straight through the DB layer.
 *
 * Group chats were retired on 2026-10-09: no route or service creates one any
 * more, but the rows that existed stay as read-only history (every member
 * message, invite, removal or card decision there is 409 `group_closed`, and the
 * engine never runs a turn there). Tests that pin that behaviour build the old
 * shape here: a `bots` session, a `kind = 'group'` conversation led by the first
 * Bot, and a lead / member roster in order.
 */

import { sql } from 'drizzle-orm';
import type { DatabaseProvider } from '@greenhouse/db';

export interface LegacyGroupInput {
  userId: string;
  /** Roster in order; the first Bot was the group's lead. */
  botIds: string[];
  title?: string;
  /** The group's rules (history only). */
  description?: string;
  /** The retired Bot-chat switch as an old row may still hold it. */
  allowBotChat?: boolean;
}

export async function insertLegacyGroup(db: DatabaseProvider, input: LegacyGroupInput): Promise<string> {
  const title = input.title ?? null;
  const session = await db.sessions.create(title ?? undefined, 'sprouty', input.userId, undefined, 'bots');
  const now = new Date().toISOString();
  await db.executeRaw(sql`
    INSERT INTO bot_conversations
      (session_id, user_id, kind, owner_bot_id, lead_bot_id, title, description, allow_bot_chat,
       last_activity_at, created_at, updated_at)
    VALUES
      (${session.id}, ${input.userId}, 'group', NULL, ${input.botIds[0] ?? null}, ${title},
       ${input.description ?? ''}, ${input.allowBotChat ?? true}, ${now}, ${now}, ${now})
  `);
  for (const [position, botId] of input.botIds.entries()) {
    await db.executeRaw(sql`
      INSERT INTO bot_conversation_members (session_id, user_id, bot_id, role, position, added_by, joined_at)
      VALUES (${session.id}, ${input.userId}, ${botId}, ${position === 0 ? 'lead' : 'member'}, ${position}, 'user', ${now})
    `);
  }
  return session.id;
}
