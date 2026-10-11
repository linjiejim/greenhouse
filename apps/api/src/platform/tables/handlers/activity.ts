/**
 * Record activity (history events + comments) and @mentions — slice C.
 *
 * Who may do what (spec 20261011-tables-foundation §7, action table):
 *  - anyone who can read the record reads its activity (`tables.data.read`);
 *    field changes come back cut to what they may read (`readScope`, kernel
 *    `record.values` capped), so a masked reader sees who and when only;
 *  - anyone who can read the record may comment (`tables.data.comment` plus
 *    the kernel `comment` entity scope on the Base);
 *  - only the author edits a comment; the author or a Base builder+ deletes
 *    it (a custom role deletes only its own).
 *
 * Every id outside the caller's reach — a record outside its row scope, a
 * comment on such a record — answers 404 exactly like one that does not exist.
 * History itself is written by every record write (`onRecordWritten`).
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import { tableCommentView } from '@greenhouse/db';
import { tableRoleAtLeast } from '@greenhouse/types/table-access';
import type { TableRecordActivityPage, TableRecordActivityViewer } from '@greenhouse/types/tables';
import { requireBase, requireTableData, type TableDataAccess } from '../access.js';
import { notifyCommentMentions, resolveMentionedUserIds } from '../mentions.js';
import { getPlatformRuntime } from '../../runtime.js';
import {
  fail,
  ok,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type HandlerRequest,
  type TablesHandlers,
} from './shared.js';

type Context = Parameters<Handler>[1];

const RECORD_NOT_FOUND = 'Record not found';
const COMMENT_NOT_FOUND = 'Comment not found';

/**
 * The kernel ceiling on comments: the `comment` entity scope on this Base.
 * Without it the caller neither sees nor writes comments. (The comment
 * actions' own capability is checked by dispatch before any handler runs.)
 */
async function commentsAllowed(request: HandlerRequest, context: Context, data: TableDataAccess): Promise<boolean> {
  return Boolean(await requireBase(context, request.actor, data.base.id, 'comment', 'viewer', { allowCustom: true }));
}

/** Base builder+ may remove anyone's comment; a custom role never moderates. */
function moderates(data: TableDataAccess): boolean {
  const level = data.access.level;
  return level !== 'custom' && level !== 'none' && tableRoleAtLeast(level, 'builder');
}

function bodyOf(payload: Record<string, unknown>): string {
  return stringValue(payload, 'body') ?? '';
}

/**
 * A live comment the caller can reach: the comment, its table's data access
 * and the record still inside the caller's row scope. Undefined = 404.
 */
async function reachableComment(request: HandlerRequest, context: Context, commentId: number) {
  const comment = await context.db.tables.getComment(commentId);
  if (!comment) return undefined;
  const data = await requireTableData(request, context, comment.table_id, 'read', { allowMaskedValues: true });
  if (!data) return undefined;
  const record = await context.db.tables.getRecord(comment.table_id, comment.record_id, data.scope);
  return record ? { comment, data } : undefined;
}

const listRecordActivity: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const recordId = positiveInt(payload, 'recordId');
  if (!tableId || !recordId) return fail('INVALID_INPUT', 'tableId and recordId are required');
  const data = await requireTableData(request, context, tableId, 'read', { allowMaskedValues: true });
  if (!data) return fail('NOT_FOUND', RECORD_NOT_FOUND);
  const [visible, capability] = await Promise.all([
    commentsAllowed(request, context, data),
    // Reading needs only `tables.data.read`; posting also needs the comment capability.
    getPlatformRuntime().authorize(request.actor, 'tables.data.comment'),
  ]);
  const canComment = visible && capability.allowed;
  const page = await context.db.tables.listRecordActivity(tableId, recordId, data.scope, data.readScope, {
    cursor: stringValue(payload, 'cursor') || null,
    limit: positiveInt(payload, 'limit'),
    includeComments: visible,
  });
  if (!page) return fail('NOT_FOUND', RECORD_NOT_FOUND);
  const viewer: TableRecordActivityViewer = {
    userId: effectiveUserId(request.actor),
    canComment,
    canModerate: canComment && moderates(data),
  };
  return ok({ ...page, viewer } satisfies TableRecordActivityPage);
};

const createComment: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const recordId = positiveInt(payload, 'recordId');
  if (!tableId || !recordId) return fail('INVALID_INPUT', 'tableId and recordId are required');
  const data = await requireTableData(request, context, tableId, 'read', { allowMaskedValues: true });
  if (!data) return fail('NOT_FOUND', RECORD_NOT_FOUND);
  if (!(await context.db.tables.getRecord(tableId, recordId, data.scope))) return fail('NOT_FOUND', RECORD_NOT_FOUND);
  if (!(await commentsAllowed(request, context, data))) return fail('FORBIDDEN', 'Comments are not available here');

  const authorId = effectiveUserId(request.actor);
  const body = bodyOf(payload);
  const comment = await context.db.tables.createComment(
    { tableId, recordId, authorId, body, mentions: await resolveMentionedUserIds(context, body) },
    data.scope,
  );
  if (!comment) return fail('NOT_FOUND', RECORD_NOT_FOUND);
  await notifyCommentMentions(context, {
    base: data.base,
    tableId,
    recordId,
    comment,
    authorId,
    userIds: comment.mentions,
  });
  return ok({ comment: tableCommentView(comment) });
};

const updateComment: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const commentId = positiveInt(payload, 'commentId');
  if (!commentId) return fail('INVALID_INPUT', 'commentId is required');
  const reached = await reachableComment(request, context, commentId);
  if (!reached) return fail('NOT_FOUND', COMMENT_NOT_FOUND);
  const { comment, data } = reached;
  const actorId = effectiveUserId(request.actor);
  if (!(await commentsAllowed(request, context, data))) return fail('FORBIDDEN', 'Comments are not available here');
  if (comment.author_id !== actorId) return fail('FORBIDDEN', 'Only the author can edit a comment');

  const body = bodyOf(payload);
  const updated = await context.db.tables.updateComment(
    commentId,
    { body, mentions: await resolveMentionedUserIds(context, body) },
    data.scope,
  );
  if (!updated) return fail('NOT_FOUND', COMMENT_NOT_FOUND);
  // Only people this edit adds hear about it; the dedupe key covers a replay.
  const before = new Set(comment.mentions);
  await notifyCommentMentions(context, {
    base: data.base,
    tableId: updated.table_id,
    recordId: updated.record_id,
    comment: updated,
    authorId: actorId,
    userIds: updated.mentions.filter((id) => !before.has(id)),
  });
  return ok({ comment: tableCommentView(updated) });
};

const deleteComment: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const commentId = positiveInt(payload, 'commentId');
  if (!commentId) return fail('INVALID_INPUT', 'commentId is required');
  const reached = await reachableComment(request, context, commentId);
  if (!reached) return fail('NOT_FOUND', COMMENT_NOT_FOUND);
  const { comment, data } = reached;
  if (!(await commentsAllowed(request, context, data))) return fail('FORBIDDEN', 'Comments are not available here');
  if (comment.author_id !== effectiveUserId(request.actor) && !moderates(data)) {
    return fail('FORBIDDEN', 'Only the author or a Base builder can delete a comment');
  }
  const deleted = await context.db.tables.deleteComment(commentId, data.scope);
  return deleted ? ok({ deleted: true, commentId }) : fail('NOT_FOUND', COMMENT_NOT_FOUND);
};

export const activityHandlers = {
  listRecordActivity,
  createComment,
  updateComment,
  deleteComment,
} satisfies TablesHandlers;
