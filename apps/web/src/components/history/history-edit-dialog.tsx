/**
 * Rate & comment a conversation. Mount it keyed by session id so the draft
 * state is seeded from the session and thrown away when a different row opens.
 */

import React from 'react';
import { Button, Dialog, StarRating, Textarea } from '../ui';
import type { HistorySession } from './filter-model';
import { useT } from '../../lib/i18n';

interface HistoryEditDialogProps {
  session: HistorySession;
  onClose: () => void;
  onSave: (session: HistorySession, values: { rating: number; comment: string }) => void;
}

export function HistoryEditDialog({ session, onClose, onSave }: HistoryEditDialogProps) {
  const t = useT();
  const [rating, setRating] = React.useState(session.rating || 0);
  const [comment, setComment] = React.useState(session.comment || '');

  return (
    <Dialog open onClose={onClose} title={t('chat.rateAndComment')} size="md">
      <div className="space-y-4">
        <div>
          <label className="text-sm text-fg-muted mb-2 block">{t('chat.rating')}</label>
          <StarRating value={rating} onChange={setRating} />
        </div>
        <div>
          <label className="text-sm text-fg-muted mb-2 block">{t('history.adminComment')}</label>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder={t('history.reviewNotesPlaceholder')}
            className="bg-surface-sunken"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => onSave(session, { rating, comment })}>{t('common.save')}</Button>
        </div>
      </div>
    </Dialog>
  );
}
