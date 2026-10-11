/**
 * 👍 / 👎 on a reply from someone else's public Agent (spec 20261011-agent-first-class P4, D38):
 * `POST /api/bots/conversations/:id/messages/:messageId/feedback`. A 👎 asks — optionally — for one
 * line on what could be better; the rating is saved first, so skipping loses nothing. Its owner sees
 * the rating and that line, never the conversation. One rating per member and reply: rating again
 * replaces it (the server has no "unrate").
 *
 * Sits in the reply's action row (`MessageBubble.renderFooterActions`), with Chat's own thumbs
 * buttons. The server does not return earlier ratings with the transcript, so what was rated in this
 * tab is remembered here (module scope) across remounts — after a reload the buttons start blank.
 */

import { useState } from 'react';
import { Button, Dialog, Textarea, toast } from '../ui';
import { FormActions } from '../form';
import { ThumbsDown, ThumbsUp } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { rateReply } from '../../lib/api/bots';
import { FeedbackVoteButton } from '../chat/message-feedback';

const COMMENT_MAX = 1000;

/** Ratings given in this tab, by message id. */
const rated = new Map<string, 1 | -1>();

/** Test hook: forget what this tab rated. */
export function resetReplyRatings(): void {
  rated.clear();
}

export function ReplyFeedback({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const t = useT();
  const [rating, setRating] = useState<1 | -1 | null>(() => rated.get(messageId) ?? null);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (next: 1 | -1, note?: string): Promise<boolean> => {
    const before = rating;
    setRating(next);
    rated.set(messageId, next);
    try {
      await rateReply(sessionId, messageId, next, note);
      return true;
    } catch {
      setRating(before);
      if (before === null) rated.delete(messageId);
      else rated.set(messageId, before);
      toast(t('bots.replyFeedback.failed'), 'error');
      return false;
    }
  };

  const vote = (next: 1 | -1) => {
    if (saving) return;
    if (next === 1) {
      if (rating !== 1) void save(1);
      return;
    }
    setComment('');
    setAsking(true);
    if (rating !== -1) void save(-1);
  };

  const sendComment = async () => {
    const note = comment.trim().slice(0, COMMENT_MAX);
    if (!note) {
      setAsking(false);
      return;
    }
    setSaving(true);
    const ok = await save(-1, note);
    setSaving(false);
    if (ok) setAsking(false);
  };

  return (
    <span
      className="mr-1 inline-flex items-center gap-0.5"
      data-testid="bots-reply-feedback"
      data-rating={rating ?? ''}
    >
      <FeedbackVoteButton
        active={rating === 1}
        readonly={false}
        label={t('bots.replyFeedback.helpful')}
        onClick={() => vote(1)}
      >
        <ThumbsUp size={14} />
      </FeedbackVoteButton>
      <FeedbackVoteButton
        active={rating === -1}
        negative
        readonly={false}
        label={t('bots.replyFeedback.notHelpful')}
        onClick={() => vote(-1)}
      >
        <ThumbsDown size={14} />
      </FeedbackVoteButton>
      <Dialog open={asking} onClose={() => setAsking(false)} title={t('bots.replyFeedback.commentTitle')} size="md">
        <div className="space-y-3">
          <p className="text-xs text-fg-muted">{t('bots.replyFeedback.commentHint')}</p>
          <Textarea
            autoFocus
            rows={3}
            maxLength={COMMENT_MAX}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={t('bots.replyFeedback.commentPlaceholder')}
            aria-label={t('bots.replyFeedback.commentTitle')}
            data-testid="bots-reply-feedback-comment"
          />
          <FormActions>
            <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
              {t('bots.replyFeedback.skip')}
            </Button>
            <Button
              size="sm"
              disabled={saving || !comment.trim()}
              onClick={() => void sendComment()}
              data-testid="bots-reply-feedback-send"
            >
              {t('bots.replyFeedback.send')}
            </Button>
          </FormActions>
        </div>
      </Dialog>
    </span>
  );
}
