/**
 * The record drawer's Activity tab: the comment composer on top, then the
 * timeline (comments and field changes, newest first), older items on demand.
 *
 * The server decides everything that is about access: which changes this
 * reader may see, and `viewer` — may they comment, may they remove other
 * people's comments. The panel only offers what that allows; edit is the
 * author's own comment only. The feed re-reads when the record changes (its
 * revision, or `tables:records_changed` from someone else).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ConfirmDialog, EmptyState, Skeleton, Spinner, toast } from '../../../components/ui';
import { History } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import {
  createTableRecordComment,
  deleteTableRecordComment,
  updateTableRecordComment,
  type TableRecordCommentView,
} from '../../../lib/api/tables';
import { useTablesRecordsChanged } from '../../../hooks/use-tables-records-changed';
import { CommentItem, EventItem } from './activity-items';
import { CommentComposer } from './comment-composer';
import type { RecordDrawerSlotProps } from './slots';
import { useRecordActivity } from './use-record-activity';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function RecordActivityPanel({ table, record, fields, users, usersById }: RecordDrawerSlotProps) {
  const t = useT();
  const activity = useRecordActivity(table.id, record.id);
  const { refresh, added, replaced, removed, viewer } = activity;
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TableRecordCommentView | null>(null);
  const fieldsById = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);

  // Someone else (a person, a form, an automation) changed this record.
  useTablesRecordsChanged({ tableId: table.id, recordIds: [record.id] }, () => refresh());
  // The viewer's own edit through the record dialog bumps the revision the drawer holds.
  const seenRevision = useRef(record.revision);
  useEffect(() => {
    if (seenRevision.current === record.revision) return;
    seenRevision.current = record.revision;
    void refresh();
  }, [record.revision, refresh]);

  const post = useCallback(
    async (markdown: string) => {
      try {
        added(await createTableRecordComment(table.id, record.id, markdown));
        return true;
      } catch (error) {
        toast(errorText(error, t('tables.activity.postFailed')), 'error');
        return false;
      }
    },
    [added, record.id, t, table.id],
  );

  const save = useCallback(
    async (commentId: number, markdown: string) => {
      try {
        replaced(await updateTableRecordComment(commentId, markdown));
        setEditingId(null);
        return true;
      } catch (error) {
        toast(errorText(error, t('tables.activity.updateFailed')), 'error');
        return false;
      }
    },
    [replaced, t],
  );

  const remove = useCallback(
    async (comment: TableRecordCommentView) => {
      setConfirmDelete(null);
      try {
        await deleteTableRecordComment(comment.id);
        removed(comment.id);
        toast(t('tables.activity.commentDeleted'), 'success');
      } catch (error) {
        toast(errorText(error, t('tables.activity.deleteFailed')), 'error');
      }
    },
    [removed, t],
  );

  return (
    <div className="space-y-5">
      {viewer?.canComment && <CommentComposer users={users} submitLabel={t('tables.activity.post')} onSubmit={post} />}
      {viewer && !viewer.canComment && <p className="text-xs text-fg-faint">{t('tables.activity.cannotComment')}</p>}

      {activity.status === 'loading' && (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
      {activity.status === 'error' && (
        <EmptyState
          variant="compact"
          tone="danger"
          icon={History}
          title={t('tables.activity.loadFailed')}
          action={
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              {t('tables.activity.retry')}
            </Button>
          }
        />
      )}
      {activity.status === 'ready' && activity.items.length === 0 && (
        <EmptyState
          variant="compact"
          tone="neutral"
          icon={History}
          title={t('tables.activity.emptyTitle')}
          description={t('tables.activity.emptyDescription')}
        />
      )}
      {activity.status === 'ready' && activity.items.length > 0 && (
        <ol className="space-y-4" aria-label={t('tables.activity.timeline')}>
          {activity.items.map((item) =>
            item.kind === 'event' ? (
              <EventItem key={`event:${item.id}`} event={item} fieldsById={fieldsById} usersById={usersById} />
            ) : (
              <CommentItem
                key={`comment:${item.id}`}
                comment={item}
                usersById={usersById}
                canEdit={item.authorId === viewer?.userId && viewer.canComment}
                canDelete={Boolean(viewer?.canComment && (item.authorId === viewer.userId || viewer.canModerate))}
                onEdit={() => setEditingId(item.id)}
                onDelete={() => setConfirmDelete(item)}
                editor={
                  editingId === item.id ? (
                    <div className="mt-1">
                      <CommentComposer
                        users={users}
                        initial={item.body}
                        submitLabel={t('common.save')}
                        onSubmit={(markdown) => save(item.id, markdown)}
                        onCancel={() => setEditingId(null)}
                        autoFocus
                      />
                    </div>
                  ) : undefined
                }
              />
            ),
          )}
        </ol>
      )}
      {activity.status === 'ready' && activity.nextCursor && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => void activity.loadMore()} disabled={activity.loadingMore}>
            {activity.loadingMore && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
            {t('tables.activity.loadOlder')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
        title={t('tables.activity.deleteConfirm')}
        description={t('tables.activity.deleteDescription')}
        confirmLabel={t('tables.activity.deleteComment')}
        confirmVariant="destructive"
      />
    </div>
  );
}
