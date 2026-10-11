/**
 * 👍 / 👎 on a reply from someone else's public Agent (spec 20261011-agent-first-class P4, D38):
 * `POST /api/bots/conversations/:id/messages/:messageId/feedback`. A 👎 asks — optionally — for one
 * line on what could be better; the rating is saved first, so skipping loses nothing. Its owner sees
 * the rating and that line, never the conversation. One rating per member and reply: rating again
 * replaces it, and pressing the chosen thumb again takes it back (`DELETE …/feedback`). Both are
 * optimistic and put the previous rating back when the server refuses.
 *
 * Sits in the reply's action row (`MessageBubble.renderFooterActions`), with Chat's own thumbs
 * buttons. Every conversation page carries the member's ratings of its replies (`my_ratings`), which
 * `useBotConversation` hands to `seedReplyRatings`; they live in module scope, so a remounted reply
 * and the memoised bubbles (whose footer callback stays stable) all read the same value.
 */

import { useState, useSyncExternalStore } from 'react';
import { Button, Dialog, Textarea, toast } from '../ui';
import { FormActions } from '../form';
import { ThumbsDown, ThumbsUp } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { rateReply, unrateReply, type BotMessage } from '../../lib/api/bots';
import { FeedbackVoteButton } from '../chat/message-feedback';

const COMMENT_MAX = 1000;

type Rating = 1 | -1;

// ─── The member's ratings (shared by every reply in this tab) ──

const ratings = new Map<string, Rating>();
/**
 * Replies rated or taken back in this tab. The member is a rating's only writer, so what they chose
 * here is newer than any page — one asked before the write landed would put the old rating back.
 */
const ratedHere = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function put(messageId: string, rating: Rating | null): void {
  if (rating === null) ratings.delete(messageId);
  else ratings.set(messageId, rating);
}

function setRating(messageId: string, rating: Rating | null): void {
  put(messageId, rating);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useReplyRating(messageId: string): Rating | null {
  const read = () => ratings.get(messageId) ?? null;
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * A conversation page arrived: its replies carry the member's ratings (`my_ratings`; a reply missing
 * from it is unrated, an older server sends none) — except those rated here, which keep that choice.
 */
export function seedReplyRatings(
  messages: readonly Pick<BotMessage, 'id' | 'role' | 'bot_id'>[],
  myRatings: Readonly<Record<string, Rating>> | undefined,
): void {
  let changed = false;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.bot_id || ratedHere.has(message.id)) continue;
    const next = myRatings?.[message.id] ?? null;
    if ((ratings.get(message.id) ?? null) === next) continue;
    put(message.id, next);
    changed = true;
  }
  if (changed) notify();
}

/** Test hook: forget every rating. */
export function resetReplyRatings(): void {
  ratings.clear();
  ratedHere.clear();
  notify();
}

export function ReplyFeedback({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const t = useT();
  const rating = useReplyRating(messageId);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);

  /** Rate (`next`) or take the rating back (null): shown at once, the previous one back on a refusal. */
  const save = async (next: Rating | null, note?: string): Promise<boolean> => {
    const before = ratings.get(messageId) ?? null;
    ratedHere.add(messageId);
    setRating(messageId, next);
    try {
      if (next === null) await unrateReply(sessionId, messageId);
      else await rateReply(sessionId, messageId, next, note);
      return true;
    } catch {
      // Unless a later press already changed it.
      if ((ratings.get(messageId) ?? null) === next) setRating(messageId, before);
      toast(t('bots.replyFeedback.failed'), 'error');
      return false;
    }
  };

  const vote = (next: Rating) => {
    if (saving) return;
    if (rating === next) {
      void save(null);
      return;
    }
    if (next === -1) {
      setComment('');
      setAsking(true);
    }
    void save(next);
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
