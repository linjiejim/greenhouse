/**
 * Notifications (NTF-01): 需要你 lists every pending decision as its card, so it can be decided
 * here; 全部 lists what happened, newest first. Opening one goes back to its source.
 */

import { BellOff, CheckCheck, CircleCheck } from 'lucide-react';
import { Button, Empty, ErrorBox, Skeleton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Notification } from '@greenhouse/contract';
import { useSession } from '../../app/session';
import { RequestCard } from '../../conversation/RequestCard';
import { useMarkNotificationsRead, useNotifications } from '../../data/notifications';
import { useRequests } from '../../data/requests';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { href, navigate, type Route } from '../../lib/router';
import { fullTime, relativeTime } from '../../lib/time';
import { Page, PageHeader } from '../../shell/Page';

/** Where a notification leads. */
function targetOf(notification: Notification): Route | null {
  if (notification.run_id) return { page: 'run', id: notification.run_id };
  if (notification.target_type === 'conversation' && notification.target_id)
    return { page: 'conversation', id: notification.target_id };
  if (notification.target_type === 'agent' && notification.target_id)
    return { page: 'agent', id: notification.target_id, tab: 'profile' };
  // Knowledge: a mention, a comment or a share opens the doc or the folder.
  if (notification.target_type === 'doc' && notification.target_id) return { page: 'doc', id: notification.target_id };
  if (notification.target_type === 'folder' && notification.target_id)
    return { page: 'folder', id: notification.target_id };
  return null;
}

function NeedsYou() {
  const { t } = useI18n();
  const requests = useRequests(undefined, 'pending');
  if (requests.isPending) return <Skeleton lines={4} />;
  if (requests.isError) return <ErrorBox onRetry={() => void requests.refetch()}>{t('common.error')}</ErrorBox>;
  if (!requests.items.length)
    return <Empty icon={<CircleCheck strokeWidth={icon.stroke} />} title={t('notifications.nothingNeedsYou')} />;
  return (
    <div className="app-stack">
      {requests.items.map((request) => (
        <RequestCard key={request.id} request={request} showContext />
      ))}
    </div>
  );
}

function All() {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const notifications = useNotifications();
  const markRead = useMarkNotificationsRead();
  const timeZone = me?.timezone ?? 'Asia/Shanghai';
  if (notifications.isPending) return <Skeleton lines={6} />;
  if (notifications.isError)
    return <ErrorBox onRetry={() => void notifications.refetch()}>{t('common.error')}</ErrorBox>;
  if (!notifications.items.length)
    return <Empty icon={<BellOff strokeWidth={icon.stroke} />} title={t('notifications.empty')} />;
  return (
    <ul className="app-list" aria-label={t('notifications.all')}>
      {notifications.items.map((item) => {
        const target = targetOf(item);
        const open = () => {
          if (!item.read_at) markRead.mutate({ ids: [item.id] });
          if (target) navigate(target);
        };
        return (
          <li key={item.id}>
            <a
              className={cx('app-list-row', !item.read_at && 'is-unread')}
              href={target ? href(target) : undefined}
              onClick={(event) => {
                event.preventDefault();
                open();
              }}
            >
              <span className="app-list-main">
                <span className="app-list-title">{item.title}</span>
                {item.body && <span className="app-list-meta">{item.body}</span>}
              </span>
              <time
                className="app-list-time"
                dateTime={item.created_at}
                title={fullTime(item.created_at, { locale, timeZone })}
              >
                {relativeTime(item.created_at, { locale, timeZone })}
              </time>
              {!item.read_at && <span className="app-unread-dot" aria-label={t('row.unreadDot')} />}
            </a>
          </li>
        );
      })}
      {notifications.hasNextPage && (
        <li>
          <Button
            kind="ghost"
            loading={notifications.isFetchingNextPage}
            onClick={() => void notifications.fetchNextPage()}
          >
            {t('common.more')}
          </Button>
        </li>
      )}
    </ul>
  );
}

export function NotificationsPage({ view }: { view: 'needs' | 'all' }) {
  const { t } = useI18n();
  const markRead = useMarkNotificationsRead();
  return (
    <Page
      width="reading"
      header={
        <PageHeader
          title={view === 'needs' ? t('notifications.needsYou') : t('notifications.all')}
          primary={
            view === 'all' ? (
              <Button kind="ghost" onClick={() => markRead.mutate({ all: true })}>
                <CheckCheck size={icon.md} strokeWidth={icon.stroke} />
                {t('notifications.markAllRead')}
              </Button>
            ) : undefined
          }
        />
      }
    >
      {view === 'needs' ? <NeedsYou /> : <All />}
    </Page>
  );
}
