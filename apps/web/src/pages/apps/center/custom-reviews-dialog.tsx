/** The review page displays source as text; reviewing never executes the submitted HTML. */
import { useEffect, useState } from 'react';
import type { AppCustomReviewItem } from '@greenhouse/types/apps';
import { Button, Dialog, Spinner, Textarea } from '../../../components/ui';
import { listAppCustomReviews, reviewAppCustomCode } from '../../../lib/api/apps-reviews';
import { useT } from '../../../lib/i18n';

export function CustomReviewsDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const [items, setItems] = useState<AppCustomReviewItem[] | null>(null);
  const [selected, setSelected] = useState<AppCustomReviewItem | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    listAppCustomReviews()
      .then((items) => {
        if (alive) setItems(items);
      })
      .catch((error: unknown) => {
        if (alive) setError(error instanceof Error ? error.message : t('apps.sandbox.failed'));
      });
    return () => {
      alive = false;
    };
  }, [t]);
  const review = async (decision: 'approve' | 'reject') => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await reviewAppCustomCode(selected.app.id, selected.version, { decision, hash: selected.specHash, note });
      setItems(await listAppCustomReviews());
      setSelected(null);
      setNote('');
    } catch (error) {
      setError(error instanceof Error ? error.message : t('apps.sandbox.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={t('apps.sandbox.reviews')} size="xl">
      <div className="space-y-4" data-testid="app-custom-reviews">
        <p className="text-sm text-fg-muted">{t('apps.sandbox.reviewHint')}</p>
        {!items && !error && <Spinner />}
        {items?.length === 0 && <p>{t('apps.sandbox.emptyReviews')}</p>}
        <div className="flex flex-wrap gap-2">
          {items?.map((item) => (
            <Button
              key={`${item.app.id}:${item.version}`}
              size="sm"
              variant={selected === item ? 'default' : 'outline'}
              onClick={() => {
                setSelected(item);
                setNote('');
              }}
              disabled={busy}
            >
              {item.app.name} · v{item.version} · {t(`apps.sandbox.status.${item.review.status}`)}
            </Button>
          ))}
        </div>
        {selected && (
          <>
            <p className="break-all font-mono text-xs">sha256: {selected.specHash}</p>
            {selected.cards.map((card) => (
              <section key={`${card.pageId}:${card.cardId}`} className="space-y-2 rounded border border-edge p-3">
                <h3 className="font-semibold">
                  {card.pageId} / {card.title ?? card.cardId}
                </h3>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs" data-testid="app-review-source">
                  {card.html}
                </pre>
                <details>
                  <summary>{t('apps.sandbox.bindings')}</summary>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
                    {JSON.stringify({ bindings: card.bindings, actions: card.actions, create: card.create }, null, 2)}
                  </pre>
                </details>
                {selected.previous && (
                  <details>
                    <summary>{t('apps.sandbox.previous', { version: selected.previous.version })}</summary>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
                      {selected.previous.cards.find((old) => old.pageId === card.pageId && old.cardId === card.cardId)
                        ?.html ?? '—'}
                    </pre>
                  </details>
                )}
              </section>
            ))}
            <Textarea
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              aria-label={t('apps.sandbox.note')}
              placeholder={t('apps.sandbox.note')}
            />
            <div className="flex gap-2">
              <Button onClick={() => void review('approve')} disabled={busy} data-testid="app-review-approve">
                {t('apps.sandbox.approve')}
              </Button>
              <Button
                variant="outline"
                onClick={() => void review('reject')}
                disabled={busy}
                data-testid="app-review-reject"
              >
                {t('apps.sandbox.reject')}
              </Button>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
