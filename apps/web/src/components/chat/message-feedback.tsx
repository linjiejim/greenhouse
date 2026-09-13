/**
 * Progressive session feedback.
 *
 * Inline feedback starts with thumbs up/down. The TopBar uses one Star entry
 * because the same detail dialog already covers every rating value and note.
 */

import React, { useEffect, useState } from 'react';
import { Check, Star, ThumbsDown, ThumbsUp } from '../../lib/icons';
import * as api from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Button, Dialog, IconButton, Textarea } from '../ui';

interface MessageFeedbackProps {
  messageId: string;
  sessionId: string | null;
  initialRating?: number | null;
  initialComment?: string | null;
  inline?: boolean;
  toolbar?: boolean;
  readonly?: boolean;
}

export function MessageFeedback({
  messageId: _messageId,
  sessionId,
  initialRating,
  initialComment,
  inline,
  toolbar = false,
  readonly = false,
}: MessageFeedbackProps) {
  const t = useT();
  const [rating, setRating] = useState(initialRating ?? 0);
  const [vote, setVote] = useState<'up' | 'down' | null>(() => voteFromRating(initialRating));
  const [hoverRating, setHoverRating] = useState(0);
  const [note, setNote] = useState(initialComment || '');
  const [draftNote, setDraftNote] = useState(initialComment || '');
  const [expanded, setExpanded] = useState(false);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    setRating(initialRating ?? 0);
    setVote(voteFromRating(initialRating));
    setNote(initialComment || '');
    setDraftNote(initialComment || '');
    setExpanded(false);
  }, [initialRating, initialComment, sessionId]);

  const persist = async (updates: { rating?: number | null; comment?: string | null }) => {
    if (!sessionId || readonly) return;
    setSaveError(false);
    try {
      await api.updateSession(sessionId, updates);
    } catch {
      setSaveError(true);
      window.setTimeout(() => setSaveError(false), 2000);
    }
  };

  const handleVote = (nextVote: 'up' | 'down') => {
    if (readonly) return;
    const toggled = vote === nextVote ? null : nextVote;
    const nextRating = toggled === 'up' ? 5 : toggled === 'down' ? 1 : 0;
    setVote(toggled);
    setRating(nextRating);
    setExpanded(!!toggled);
    void persist({ rating: nextRating || null });
  };

  const handleStar = (star: number) => {
    if (readonly) return;
    const nextRating = rating === star ? 0 : star;
    setRating(nextRating);
    setVote(voteFromRating(nextRating));
    void persist({ rating: nextRating || null });
  };

  const saveNote = () => {
    const next = draftNote.trim();
    setNote(next);
    setExpanded(false);
    void persist({ comment: next || null });
  };

  const cancelDetails = () => {
    setDraftNote(note);
    setExpanded(false);
  };

  return (
    <div className="relative inline-flex max-w-full">
      <div
        className={
          toolbar
            ? 'flex items-center gap-0.5'
            : inline
              ? 'flex items-center gap-0.5 rounded-lg border border-edge bg-surface-muted px-1.5 py-1'
              : 'mt-2 flex items-center gap-0.5 border-t border-edge pt-1.5'
        }
      >
        {!toolbar && (
          <>
            <FeedbackVoteButton
              active={vote === 'up'}
              readonly={readonly}
              label={t('chat.goodResponse')}
              onClick={() => handleVote('up')}
            >
              <ThumbsUp size={14} />
            </FeedbackVoteButton>
            <FeedbackVoteButton
              active={vote === 'down'}
              negative
              readonly={readonly}
              label={t('chat.badResponse')}
              onClick={() => handleVote('down')}
            >
              <ThumbsDown size={14} />
            </FeedbackVoteButton>
          </>
        )}
        {toolbar && (
          <IconButton
            onClick={() => !readonly && setExpanded(true)}
            disabled={readonly}
            label={t('chat.rateThisResponse')}
            className={rating > 0 ? 'text-star hover:text-star-hover' : readonly ? 'text-fg-faint' : ''}
          >
            <Star size={14} className={rating > 0 ? 'fill-current' : ''} />
          </IconButton>
        )}
        {saveError && <span className="ml-1 text-[10px] text-danger">{t('chat.error')}</span>}
      </div>

      {/*
        细节面板走共享 Dialog 而不是绝对定位 popover：原来是 `absolute left-0` + 420px 固定宽，
        `max-w-[calc(100vw-2rem)]` 只在视口本身够窄时才生效——赞踩按钮挂在消息右下角时，
        面板从按钮左沿向右展开 420px，直接穿出右边界。Dialog 由视口居中并自带滚动锁、
        Escape 关闭与焦点恢复，移动端还会贴底展示，一次性消掉这类定位 bug。
      */}
      <Dialog open={expanded && !readonly} onClose={cancelDetails} title={t('chat.rateThisResponse')} size="md">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-fg-secondary">{t('chat.rating')}</span>
            <div className="flex items-center" onMouseLeave={() => setHoverRating(0)}>
              {[1, 2, 3, 4, 5].map((star) => {
                const filled = star <= (hoverRating || rating);
                return (
                  <button
                    key={star}
                    onClick={() => handleStar(star)}
                    onMouseEnter={() => setHoverRating(star)}
                    className={`inline-flex h-11 w-11 items-center justify-center rounded transition-colors sm:h-8 sm:w-8 ${
                      filled ? 'text-star' : 'text-fg-faint hover:text-star-hover'
                    }`}
                    title={`${star} star${star === 1 ? '' : 's'}`}
                    aria-label={`${star} star${star === 1 ? '' : 's'}`}
                  >
                    <Star size={16} className={filled ? 'fill-current' : ''} />
                  </button>
                );
              })}
            </div>
          </div>
          <Textarea
            autoFocus
            value={draftNote}
            onChange={(event) => setDraftNote(event.target.value)}
            placeholder={t('chat.addANote')}
            rows={3}
            className="min-h-[76px] resize-y"
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancelDetails}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={saveNote}>
              <Check size={14} />
              {t('common.save')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function voteFromRating(rating?: number | null): 'up' | 'down' | null {
  if (rating != null && rating >= 4) return 'up';
  if (rating != null && rating > 0 && rating <= 2) return 'down';
  return null;
}

function FeedbackVoteButton({
  active,
  negative = false,
  readonly,
  label,
  onClick,
  children,
}: {
  active: boolean;
  negative?: boolean;
  readonly: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={readonly}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        active
          ? negative
            ? 'bg-danger-subtle text-danger'
            : 'bg-success-subtle text-success'
          : readonly
            ? 'text-fg-faint'
            : 'text-fg-faint hover:bg-surface-sunken hover:text-fg-muted'
      } disabled:cursor-default`}
      title={`${label}${readonly ? ' (read only)' : ''}`}
      aria-label={label}
    >
      {children}
    </button>
  );
}
