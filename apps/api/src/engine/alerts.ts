/**
 * Replies and mentions as notifications (回复与提及, NTF-03).
 *
 * - Someone names a person with @: that person is told at once (`mention:<message>`). Their other
 *   channels wait a minute and stay quiet if they read the conversation meanwhile.
 * - An Agent replied after the member left: the latest reply of a turn that acted for them
 *   finished more than a minute ago and they have not read it since. Told once
 *   (`reply:<message>`), from the engine's sweep. Nothing is told while a turn of theirs is still
 *   going there or a card of theirs waits (the card already called them), nor in a conversation
 *   they muted or archived. Reading along leaves nothing in the notification center; replies
 *   older than half an hour are never told, so a restart does not back-fill old conversations.
 * - Reading a conversation reads its reply and mention notifications up to where the member read
 *   (notifications.markConversationRead).
 */

import { and, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import {
  agents,
  conversationMembers,
  conversations,
  getDb,
  members,
  messages,
  notifications,
  requests,
  runs,
  type Conversation as ConversationRow,
  type Message as MessageRow,
} from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import type { NotificationsService } from '../modules/notifications/service.js';

/** A reply nobody read for this long was missed. */
export const REPLY_QUIET_MS = 60_000;
/** Replies older than this are never told. */
export const REPLY_WINDOW_MS = 30 * 60_000;
const SWEEP_LIMIT = 500;

function replyTitle(locale: string, agent: string, title: string): string {
  if (locale === 'en') return title ? `${agent} replied in "${title}"` : `${agent} replied to you`;
  return title ? `${agent} 在「${title}」里回复了你` : `${agent} 回复了你`;
}

function mentionTitle(locale: string, sender: string, title: string): string {
  if (locale === 'en') return title ? `${sender} mentioned you in "${title}"` : `${sender} mentioned you`;
  return title ? `${sender} 在「${title}」里提到了你` : `${sender} 提到了你`;
}

type Publisher = Pick<NotificationsService, 'publish'>;

/** Tells the people a member's message names with @ (only people in the conversation, never the sender). */
export async function notifyMentions(
  notify: Publisher,
  input: { conversation: ConversationRow; message: MessageRow; senderId: string },
): Promise<void> {
  const named = [...new Set(input.message.mentions)].filter((handle) => handle !== input.senderId);
  if (!named.length) return;
  const [sender] = await getDb().select({ name: members.name }).from(members).where(eq(members.id, input.senderId));
  const people = await getDb()
    .select({ id: members.id, locale: members.locale })
    .from(conversationMembers)
    .innerJoin(members, eq(members.id, conversationMembers.memberId))
    .where(
      and(
        eq(conversationMembers.conversationId, input.conversation.id),
        inArray(conversationMembers.memberId, named),
        eq(members.status, 'active'),
      ),
    );
  for (const person of people) {
    await notify.publish({
      memberId: person.id,
      kind: 'mention',
      title: mentionTitle(person.locale, sender?.name ?? '', input.conversation.title.trim()),
      targetType: 'conversation',
      targetId: input.conversation.id,
      payload: { message_id: input.message.id, seq: input.message.seq, from_member_id: input.senderId },
      dedupeKey: `mention:${input.message.id}`,
    });
  }
}

/** One pass of the engine's sweep: tells members about the replies they missed. How many it told. */
export async function notifyMissedReplies(notify: Publisher, now = Date.now()): Promise<number> {
  const rows = await getDb()
    .select({
      memberId: runs.ownerId,
      locale: members.locale,
      conversationId: messages.conversationId,
      title: conversations.title,
      messageId: messages.id,
      seq: messages.seq,
      agentId: runs.agentId,
      agentName: agents.name,
      finishedAt: runs.finishedAt,
    })
    .from(runs)
    .innerJoin(
      messages,
      and(
        eq(messages.visible, true),
        eq(messages.runId, runs.id),
        eq(messages.role, 'assistant'),
        eq(messages.status, 'complete'),
      ),
    )
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, messages.conversationId),
        eq(conversationMembers.memberId, runs.ownerId),
      ),
    )
    .innerJoin(members, eq(members.id, runs.ownerId))
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(
      and(
        eq(runs.kind, 'turn'),
        eq(runs.status, 'succeeded'),
        gte(runs.finishedAt, new Date(now - REPLY_WINDOW_MS).toISOString()),
        lt(conversationMembers.lastReadSeq, messages.seq),
        isNull(conversationMembers.mutedAt),
        isNull(conversationMembers.archivedAt),
        eq(members.status, 'active'),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(SWEEP_LIMIT);

  // Only the latest reply in a conversation is told, once it has been quiet for a minute.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.conversationId}:${row.memberId}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const due = [...latest.values()].filter(
    (row) => row.finishedAt && Date.parse(row.finishedAt) <= now - REPLY_QUIET_MS,
  );
  if (!due.length) return 0;

  const ids = [...new Set(due.map((row) => row.conversationId))];
  const [pending, going, told] = await Promise.all([
    getDb()
      .select({ conversationId: requests.conversationId, memberId: requests.memberId })
      .from(requests)
      .where(and(inArray(requests.conversationId, ids), eq(requests.status, 'pending'))),
    getDb()
      .select({ conversationId: runs.conversationId, memberId: runs.ownerId })
      .from(runs)
      .where(
        and(
          inArray(runs.conversationId, ids),
          eq(runs.kind, 'turn'),
          inArray(runs.status, ['queued', 'running', 'waiting']),
        ),
      ),
    getDb()
      .select({ memberId: notifications.memberId, dedupeKey: notifications.dedupeKey })
      .from(notifications)
      .where(
        and(
          inArray(
            notifications.memberId,
            due.map((row) => row.memberId),
          ),
          inArray(
            notifications.dedupeKey,
            due.map((row) => `reply:${row.messageId}`),
          ),
        ),
      ),
  ]);
  const busy = new Set([...pending, ...going].map((row) => `${row.conversationId}:${row.memberId}`));
  const done = new Set(told.map((row) => `${row.memberId}:${row.dedupeKey}`));

  let written = 0;
  for (const row of due) {
    if (busy.has(`${row.conversationId}:${row.memberId}`)) continue;
    if (done.has(`${row.memberId}:reply:${row.messageId}`)) continue;
    try {
      const created = await notify.publish({
        memberId: row.memberId,
        kind: 'reply',
        title: replyTitle(row.locale, row.agentName, row.title.trim()),
        targetType: 'conversation',
        targetId: row.conversationId,
        agentId: row.agentId,
        payload: { message_id: row.messageId, seq: row.seq },
        dedupeKey: `reply:${row.messageId}`,
      });
      if (created) written += 1;
    } catch (error) {
      logger.warn('[engine] could not tell a member about a reply', {
        conversation: row.conversationId,
        error: toErrorMessage(error),
      });
    }
  }
  return written;
}
