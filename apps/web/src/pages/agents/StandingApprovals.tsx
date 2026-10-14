import { Button, ErrorBox, Skeleton } from '@greenhouse/ui/kit';
import { useNotify } from '../../app/notify';
import { useStandingApprovals, useRevokeStandingApproval } from '../../data/approvals';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';

export function StandingApprovals({ agentId }: { agentId: string }) {
  const { t } = useI18n();
  const notify = useNotify();
  const query = useStandingApprovals(agentId);
  const revoke = useRevokeStandingApproval(agentId);
  return (
    <section className="app-section" aria-label={t('approvals.title')}>
      <h2 className="app-section-title">{t('approvals.title')}</h2>
      <p className="app-muted">{t('approvals.hint')}</p>
      {query.isPending ? (
        <Skeleton lines={2} />
      ) : query.isError ? (
        <ErrorBox onRetry={() => void query.refetch()}>{t('common.error')}</ErrorBox>
      ) : !query.items.length ? (
        <p className="app-muted">{t('approvals.none')}</p>
      ) : (
        query.items.map((item) => (
          <div className="app-setting-row" key={item.id}>
            <div className="app-setting-text">
              <strong>{t(item.scope_type === 'folder' ? 'approvals.folder' : 'approvals.table')}</strong>
              {item.scope_href && <a href={item.scope_href}>{item.scope_name}</a>}
              <span>
                {item.actions
                  .map((action) =>
                    t(
                      action.endsWith('.create')
                        ? 'approvals.create'
                        : action.endsWith('.comment')
                          ? 'approvals.comment'
                          : action.endsWith('.delete')
                            ? 'approvals.delete'
                            : 'approvals.edit',
                    ),
                  )
                  .join(' · ')}
              </span>
            </div>
            <Button
              loading={revoke.isPending}
              onClick={() => revoke.mutate(item.id, { onError: (error) => notify(errorText(error, t)) })}
            >
              {t('approvals.revoke')}
            </Button>
          </div>
        ))
      )}
      {query.hasNextPage && <Button onClick={() => void query.fetchNextPage()}>{t('approvals.showMore')}</Button>}
    </section>
  );
}
