/**
 * @-mentions in Tables record comments → the platform notification center.
 *
 * A mention is a `[@Name](user:<id>)` link (`@greenhouse/utils/mentions`).
 * Only active internal users count; each one other than the author who can
 * read the record (`canRecipientRead` — Base access today, app audiences in
 * Phase 1) gets one `tables_mention` fact, idempotent per comment × person, with
 * a link that opens the record the way they can reach it. Anyone else is
 * skipped silently: a mention must never tell its author who can see what.
 *
 * Never fails the comment it reports: errors are logged per recipient.
 */

import type { TableBaseRow, TableRecordCommentRow, UserRow } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { extractMentionIds, mentionsToPlainText } from '@greenhouse/utils/mentions';
import { botsLocale, type BotsLocale } from '../../bots/engine/copy.js';
import { publishNotification } from '../../notifications/publish.js';
import type { PlatformHandlerContext } from '../runtime.js';
import { canRecipientRead, type RecipientReadAccess } from './access.js';

type MentionContext = Pick<PlatformHandlerContext, 'db'>;

/** A comment may address at most this many people; the rest are plain text. */
export const MAX_COMMENT_MENTIONS = 20;
const PREVIEW_LENGTH = 280;

const COPY: Record<BotsLocale, { title: (author: string, table: string, recordId: number) => string }> = {
  en: { title: (author, table, recordId) => `${author} mentioned you on ${table} · #${recordId}` },
  zh: { title: (author, table, recordId) => `${author} 在「${table}」#${recordId} 中提到了你` },
};

function isActiveInternal(user: UserRow | undefined): user is UserRow {
  return !!user && user.status === 'active' && (user.role === 'team' || user.role === 'super');
}

/** The people a comment body mentions: active internal users only, first occurrence order, capped. */
export async function resolveMentionedUserIds(ctx: MentionContext, body: string): Promise<string[]> {
  const ids = extractMentionIds(body).slice(0, MAX_COMMENT_MENTIONS);
  const users = await Promise.all(ids.map((id) => ctx.db.users.getById(id)));
  return users.filter(isActiveInternal).map((user) => user.id);
}

/** Where the notification opens the record: the Tables route, or the app the person reaches it through. */
export function mentionHref(access: RecipientReadAccess, baseId: number, tableId: number, recordId: number): string {
  return access.via === 'app'
    ? `#/apps/${access.appId}?record=${recordId}`
    : `#/tables/${baseId}/table/${tableId}?record=${recordId}`;
}

/** The comment as one line of plain text for an inbox row. */
export function mentionPreview(body: string): string {
  const text = mentionsToPlainText(body).replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
}

export interface NotifyMentionsInput {
  base: Pick<TableBaseRow, 'id'>;
  tableId: number;
  recordId: number;
  comment: Pick<TableRecordCommentRow, 'id' | 'body'>;
  authorId: string;
  /** Who to tell — the comment's mentions, or only the ones an edit added. */
  userIds: readonly string[];
}

/** Publish one `tables_mention` per mentioned reader. Returns who was notified (tests, logs). */
export async function notifyCommentMentions(ctx: MentionContext, input: NotifyMentionsInput): Promise<string[]> {
  const recipients = [...new Set(input.userIds)].filter((id) => id !== input.authorId);
  if (recipients.length === 0) return [];
  const [author, table] = await Promise.all([
    ctx.db.users.getById(input.authorId),
    ctx.db.tables.getTable(input.tableId),
  ]);
  const authorName = author?.nickname || author?.email || '—';
  const tableName = table?.name ?? '—';
  const body = mentionPreview(input.comment.body);
  const notified: string[] = [];
  for (const userId of recipients) {
    try {
      const user = await ctx.db.users.getById(userId);
      if (!isActiveInternal(user)) continue;
      const access = await canRecipientRead(ctx, userId, { id: input.recordId, table_id: input.tableId });
      if (!access) continue;
      await publishNotification(ctx.db, {
        user_id: userId,
        kind: 'tables_mention',
        title: COPY[botsLocale(user.locale)].title(authorName, tableName, input.recordId).slice(0, 512),
        body,
        payload: {
          href: mentionHref(access, input.base.id, input.tableId, input.recordId),
          baseId: input.base.id,
          tableId: input.tableId,
          recordId: input.recordId,
          commentId: input.comment.id,
        },
        dedupe_key: `tables-mention:${input.comment.id}:${userId}`,
      });
      notified.push(userId);
    } catch (error) {
      logger.warn('[Tables] could not notify a mention', {
        commentId: input.comment.id,
        userId,
        error: toErrorMessage(error),
      });
    }
  }
  return notified;
}
