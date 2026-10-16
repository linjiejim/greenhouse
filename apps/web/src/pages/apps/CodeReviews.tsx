import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, ErrorBox, Overlay, Skeleton, StatusBadge } from '@greenhouse/ui/kit';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { refreshApps } from '../../data/apps';
import { appsError } from './errors';

export function CodeReviews({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const query = useInfiniteQuery({
    queryKey: ['apps', 'reviews'],
    queryFn: ({ pageParam }) => api.apps.reviews({ cursor: pageParam, limit: 20 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });
  const decide = async (app: string, version: number, hash: string, decision: 'approved' | 'rejected') => {
    setBusy(true);
    setError('');
    try {
      await api.apps.review(app, version, hash, decision);
      await refreshApps();
    } catch (e) {
      setError(appsError(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay variant="drawer" wide title={t('apps.codeReviews')} onClose={onClose}>
      {query.isPending ? (
        <Skeleton lines={4} />
      ) : query.error ? (
        <ErrorBox onRetry={() => void query.refetch()}>{appsError(query.error, t)}</ErrorBox>
      ) : (
        query.data?.pages
          .flatMap((p) => p.items)
          .filter((v) => v.spec.pages.some((p) => p.cards.some((c) => c.kind === 'custom')))
          .map((version) => (
            <article className="app-ap-tile" key={version.id}>
              <h2>
                {version.name} · {t('apps.version', { version: version.version })}
              </h2>
              <StatusBadge
                status={t(`apps.review.${version.review_status as 'pending' | 'approved' | 'rejected'}`)}
                tone="neutral"
              />
              <pre className="app-ap-code">{JSON.stringify(version.spec, null, 2)}</pre>
              <div className="app-inline-actions">
                <Button
                  disabled={busy}
                  onClick={() => void decide(version.app_id, version.version, version.spec_hash, 'approved')}
                >
                  {t('apps.approveCode')}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void decide(version.app_id, version.version, version.spec_hash, 'rejected')}
                >
                  {t('apps.rejectCode')}
                </Button>
              </div>
            </article>
          ))
      )}
      {query.hasNextPage && <Button onClick={() => void query.fetchNextPage()}>{t('knowledge.showMore')}</Button>}
      {error && <p role="alert">{error}</p>}
    </Overlay>
  );
}
