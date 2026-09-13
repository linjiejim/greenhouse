/**
 * History session list — one row per conversation plus the shared list footer.
 * Pagination is the repo-standard `<Pagination>`; the old "Load more" button
 * grew the page without ever letting you go back.
 */

import React from 'react';
import { Badge, EmptyState, Pagination, Spinner } from '../ui';
import { Archive, Inbox, Pencil, RotateCcw, Share2, Star, ThumbsDown, ThumbsUp, Trash2 } from '../../lib/icons';
import type { LucideIcon } from '../../lib/icons';
import { SessionTypeIcon } from '../chat/session-type-icon';
import { TagBadge } from '../session-tags';
import type { HistorySession } from './filter-model';
import { useT } from '../../lib/i18n';
import { formatDate } from '../../lib/utils';

interface HistoryListProps {
  /** The current page's rows. */
  sessions: HistorySession[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  loading: boolean;
  /** Status bucket being viewed — used for the empty-state copy. */
  status: string;
  onOpen: (session: HistorySession) => void;
  onEdit: (session: HistorySession) => void;
  onStatusChange: (session: HistorySession, status: string) => void;
  onDelete: (session: HistorySession) => void;
}

export function HistoryList({
  sessions,
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  loading,
  status,
  onOpen,
  onEdit,
  onStatusChange,
  onDelete,
}: HistoryListProps) {
  const t = useT();
  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-2">
        {loading && total === 0 && (
          <div className="flex justify-center py-8">
            <Spinner className="h-6 w-6 text-fg-faint" />
          </div>
        )}

        {!loading && total === 0 && (
          <EmptyState
            icon={Inbox}
            variant="compact"
            tone="neutral"
            title={t('history.noConversations')}
            description={t('history.noStatusConversations', { status })}
          />
        )}

        <div className="space-y-0.5">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onOpen={onOpen}
              onEdit={onEdit}
              onStatusChange={onStatusChange}
              onDelete={onDelete}
            />
          ))}
        </div>
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </>
  );
}

function SessionRow({
  session,
  onOpen,
  onEdit,
  onStatusChange,
  onDelete,
}: Pick<HistoryListProps, 'onOpen' | 'onEdit' | 'onStatusChange' | 'onDelete'> & {
  session: HistorySession;
}) {
  const t = useT();
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div
      className="bg-surface-card border border-edge rounded-md px-3 py-2 hover:border-primary-300 hover:bg-primary-subtle/30 transition-colors cursor-pointer group"
      onClick={() => onOpen(session)}
    >
      {/* Row 1 */}
      <div className="flex items-center gap-2 min-w-0">
        <h3
          className="text-sm text-fg truncate flex-1 min-w-0 font-medium"
          title={session.title || t('common.untitled')}
        >
          {session.title || t('common.untitled')}
        </h3>
        {session.shared && (
          <Badge variant="secondary">
            <Share2 size={10} className="mr-0.5 inline" />
            {t('history.shared')}
          </Badge>
        )}
        {/* Rating and feedback are read-only here. They are set where they are
            earned — in the conversation's own feedback panel, and via the
            sidebar's star — so a second set of writable controls on every row
            was nine interactive glyphs paying for a duplicate path. */}
        {session.rating ? (
          <span
            className="flex flex-shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-star"
            title={t('chat.rating')}
          >
            <Star size={10} className="fill-current" />
            {session.rating}
          </span>
        ) : null}
        <div className="flex-shrink-0">{feedbackBadge(session.feedback)}</div>
        <div className="flex flex-shrink-0 items-center gap-0 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
          <RowActionButton icon={Pencil} title={t('history.adminComment')} onClick={stop(() => onEdit(session))} />
          {session.status === 'deleted' || session.status === 'archived' ? (
            <RowActionButton
              icon={RotateCcw}
              title={t('common.restore')}
              onClick={stop(() => onStatusChange(session, 'active'))}
            />
          ) : (
            <RowActionButton
              icon={Archive}
              title={t('common.archive')}
              onClick={stop(() => onStatusChange(session, 'archived'))}
            />
          )}
          <RowActionButton icon={Trash2} title={t('common.delete')} onClick={stop(() => onDelete(session))} />
        </div>
      </div>

      {/* Row 2 */}
      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-fg-faint min-w-0">
        <span className="flex-shrink-0">{formatDate(session.updated_at)}</span>
        <span className="hidden md:inline font-mono flex-shrink-0">{session.id.slice(0, 8)}</span>
        <SessionTypeIcon profileId={session.profile_id} size={11} />
        {session.comment && (
          <span className="text-fg-muted truncate min-w-0 flex items-center gap-0.5">
            <Pencil size={9} /> {session.comment}
          </span>
        )}
        {session.tags && session.tags.length > 0 && (
          <span className="flex items-center gap-1 flex-shrink-0">
            {session.tags.map((tag) => (
              <TagBadge key={tag.id} name={tag.name} color={tag.color} />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

function RowActionButton({
  icon: Icon,
  title,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-xs text-fg-faint transition-colors hover:bg-surface-muted hover:text-fg-secondary"
    >
      <Icon size={12} />
    </button>
  );
}

function feedbackBadge(feedback: string | null) {
  if (!feedback) return null;
  const map: Record<string, { variant: 'default' | 'success' | 'destructive'; icon: LucideIcon }> = {
    good: { variant: 'success', icon: ThumbsUp },
    bad: { variant: 'destructive', icon: ThumbsDown },
    starred: { variant: 'default', icon: Star },
  };
  const info = map[feedback];
  if (!info) return null;
  return (
    <Badge variant={info.variant}>
      <info.icon size={10} />
    </Badge>
  );
}
