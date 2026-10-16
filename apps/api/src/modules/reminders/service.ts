import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { conversations as conversationRows, getDb, members, newId, reminders, transaction } from '@greenhouse/db';
import type { ConversationsService } from '../conversations/service.js';
import { toMessage } from '../conversations/service.js';
import type { NotificationsService } from '../notifications/service.js';
import { enqueueJob } from '../../jobs.js';
import { ApiError, conflict, notFound } from '../../http/errors.js';
import { decodeCursor, toPage } from '../../http/pagination.js';

export const REMINDER_JOB = 'reminder_deliver';
export function createRemindersService(deps: {
  conversations: ConversationsService;
  notifications: NotificationsService;
}) {
  async function target(memberId: string, conversationId: string) {
    const { conversation } = await deps.conversations.access(memberId, conversationId);
    if (conversation.kind === 'room' || conversation.ownerId !== memberId)
      throw new ApiError(403, 'private_conversation_required', 'Reminders belong in your own private conversation.');
    await getDb()
      .select({ id: conversationRows.id })
      .from(conversationRows)
      .where(eq(conversationRows.id, conversationId))
      .for('update');
    return conversation;
  }
  async function own(memberId: string, id: string, conversationId?: string) {
    const [row] = await getDb()
      .select()
      .from(reminders)
      .where(and(eq(reminders.id, id), eq(reminders.ownerId, memberId)));
    if (!row || (conversationId && row.conversationId !== conversationId)) throw notFound('Reminder');
    await target(memberId, row.conversationId);
    const [locked] = await getDb().select().from(reminders).where(eq(reminders.id, id)).for('update');
    if (!locked) throw notFound('Reminder');
    return locked;
  }
  const view = (row: typeof reminders.$inferSelect) => ({
    id: row.id,
    text: row.text,
    due_at: row.dueAt,
    timezone: row.timezone,
    status: row.status,
    revision: row.revision,
  });
  async function queue(row: typeof reminders.$inferSelect) {
    await enqueueJob({
      kind: REMINDER_JOB,
      dedupeKey: `reminder:${row.id}:${row.revision}`,
      payload: { reminder_id: row.id, revision: row.revision },
      availableAt: row.dueAt,
    });
  }
  return {
    async create(memberId: string, conversationId: string, agentId: string, input: { text: string; due_at: string }) {
      return transaction(async (db) => {
        await target(memberId, conversationId);
        const [member] = await db.select({ timezone: members.timezone }).from(members).where(eq(members.id, memberId));
        await db.select({ id: members.id }).from(members).where(eq(members.id, memberId)).for('update');
        const due = Date.parse(input.due_at);
        if (!Number.isFinite(due) || due <= Date.now() || due > Date.now() + 366 * 86400_000)
          throw new ApiError(
            400,
            'reminder_time',
            'Choose a reminder time in the coming year, with an explicit UTC offset.',
          );
        const pending = await db
          .select({ id: reminders.id })
          .from(reminders)
          .where(and(eq(reminders.ownerId, memberId), eq(reminders.status, 'pending')))
          .limit(100);
        if (pending.length >= 100) throw conflict('reminder_limit', 'You can have up to 100 pending reminders.');
        const [row] = await db
          .insert(reminders)
          .values({
            id: newId('reminder'),
            ownerId: memberId,
            conversationId,
            agentId,
            text: input.text,
            dueAt: new Date(due).toISOString(),
            timezone: member?.timezone ?? 'UTC',
          })
          .returning();
        await queue(row!);
        return view(row!);
      });
    },
    async list(memberId: string, conversationId: string, query: { cursor?: string; limit: number }) {
      await target(memberId, conversationId);
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(reminders)
        .where(
          and(
            eq(reminders.ownerId, memberId),
            eq(reminders.conversationId, conversationId),
            before ? lt(reminders.id, before) : undefined,
          ),
        )
        .orderBy(desc(reminders.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, view);
    },
    async get(memberId: string, id: string, conversationId?: string) {
      return view(await own(memberId, id, conversationId));
    },
    async cancel(memberId: string, id: string, conversationId?: string) {
      return transaction(async (db) => {
        const row = await own(memberId, id, conversationId);
        if (row.status !== 'pending') throw conflict('reminder_finished', 'This reminder is no longer pending.');
        const [saved] = await db
          .update(reminders)
          .set({ status: 'canceled', revision: row.revision + 1, updatedAt: sql`now()` })
          .where(eq(reminders.id, id))
          .returning();
        return view(saved!);
      });
    },
    async undo(memberId: string, id: string, written: number, status: 'pending' | 'canceled') {
      await transaction(async (db) => {
        const row = await own(memberId, id);
        if (
          row.revision !== written ||
          row.status === 'delivered' ||
          (status === 'pending' && Date.parse(row.dueAt) <= Date.now())
        )
          throw conflict('undo_conflict', 'This reminder changed or its time has passed.');
        const [saved] = await db
          .update(reminders)
          .set({ status, revision: row.revision + 1, updatedAt: sql`now()` })
          .where(eq(reminders.id, id))
          .returning();
        if (status === 'pending') await queue(saved!);
      });
    },
    async deliver(id: string, revision: number) {
      let posted: Awaited<ReturnType<ConversationsService['append']>> | null = null;
      await transaction(async (db) => {
        const [found] = await db.select().from(reminders).where(eq(reminders.id, id));
        if (!found) return;
        const [member] = await db.select({ status: members.status }).from(members).where(eq(members.id, found.ownerId));
        if (member?.status !== 'active') return;
        try {
          await target(found.ownerId, found.conversationId);
        } catch (error) {
          if (error instanceof ApiError && [403, 404].includes(error.status)) return;
          throw error;
        }
        const [row] = await db.select().from(reminders).where(eq(reminders.id, id)).for('update');
        if (!row || row.status !== 'pending' || row.revision !== revision || Date.parse(row.dueAt) > Date.now()) return;
        posted = await deps.conversations.append(row.conversationId, {
          role: 'event',
          agentId: row.agentId,
          content: row.text,
          event: { type: 'reminder', reminder_id: row.id },
        });
        await db
          .update(reminders)
          .set({ status: 'delivered', messageId: posted.id, revision: row.revision + 1, updatedAt: sql`now()` })
          .where(eq(reminders.id, id));
        await deps.notifications.publish({
          memberId: row.ownerId,
          kind: 'reply',
          title: '⏰ ' + row.text,
          targetType: 'conversation',
          targetId: row.conversationId,
          agentId: row.agentId,
          payload: { conversation_id: row.conversationId, message_id: posted.id },
          dedupeKey: `reminder:${id}`,
        });
      });
      if (posted)
        await deps.conversations.publish((posted as { conversationId: string }).conversationId, {
          type: 'message.created',
          data: { message: toMessage(posted) },
        });
    },
  };
}
export type RemindersService = ReturnType<typeof createRemindersService>;
