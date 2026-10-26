import { useExtensionsStore } from '../../stores/extensions-store';
/**
 * The bell's dialog — platform notifications, sessions shared with me, and team
 * activity (what people and their agents changed lately, only what the viewer
 * may read). One instance lives at the app root; `useUIStore` opens it.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ShareItem } from '@greenhouse/types/api';
import type { PlatformNotification } from '@greenhouse/types/notification';
import type { ActivityItem } from '@greenhouse/types/activity';

import { CheckCheck, History, Inbox, MessageSquare, Users } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { executionNotificationHref } from '../../lib/execution-route';
import { notificationCopy } from '../../lib/notification-copy';
import { timeAgo, markdownPreview } from '../../lib/utils';
import * as api from '../../lib/api';
import { useUIStore, useWsStore } from '../../stores';
import type { InboxTab } from '../../stores/ui-store';
import { fetchRecentChanges } from '../../lib/api/activity';
import { ACTIVITY_ROOT_HASH } from '../../lib/execution-route';
import { ActivityRow } from '../activity/activity-row';
import { Badge, Button, Dialog, EmptyState, Spinner } from '../ui';
import { AUTOMATIONS_PROFILES_HASH } from '../../lib/workspace-routes';

const ACTIVITY_PAGE = 20;

function notificationHref(item: PlatformNotification): string | null {
  if (item.run_id) {
    // Historical notifications predate the kind segment; the run-detail
    // router keeps this compatibility form readable.
    return executionNotificationHref(item.run_id, item.payload);
  }
  if (item.agent_id) return AUTOMATIONS_PROFILES_HASH;
  // A system notice may name an in-app page to open (the monthly retro links its doc).
  const payload = item.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const url = (payload as Record<string, unknown>).url;
    if (typeof url === 'string' && url.startsWith('#/')) return url;
  }
  return null;
}

/**
 * Team activity: loaded the first time its tab opens, then paged with the
 * `before` cursor. It has no unread state, so the tab has no "mark all read".
 */
function TeamActivityTab({ onNavigate }: { onNavigate: () => void }) {
  const t = useT();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const requested = useRef(false);

  const load = useCallback(
    async (before: string | null) => {
      try {
        const page = await fetchRecentChanges({ limit: ACTIVITY_PAGE, before });
        setItems((current) => (before ? [...(current ?? []), ...page.items] : page.items));
        setNextBefore(page.next_before);
        setError('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('inbox.activity.failed'));
        setItems((current) => current ?? []);
      }
    },
    [t],
  );

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void load(null);
  }, [load]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    await load(nextBefore);
    setLoadingMore(false);
  };

  if (items === null) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="px-1 text-xs text-fg-muted">{t('inbox.activity.hint')}</p>
      {error && items.length === 0 ? (
        <EmptyState
          icon={History}
          variant="compact"
          tone="danger"
          title={t('inbox.activity.failed')}
          description={error}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={History}
          variant="compact"
          tone="neutral"
          title={t('inbox.activity.empty')}
          description={t('inbox.activity.emptyHint')}
        />
      ) : (
        <div
          className="-mx-1 divide-y divide-edge"
          role="list"
          data-testid="inbox-team-activity"
          // Rows are links; following one leaves the dialog behind.
          onClickCapture={(event) => {
            if ((event.target as HTMLElement).closest('a[href]')) onNavigate();
          }}
        >
          {items.map((item) => (
            <div role="listitem" key={item.id}>
              <ActivityRow item={item} compact />
            </div>
          ))}
        </div>
      )}
      {nextBefore && (
        <div className="flex justify-center pt-1">
          <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? <Spinner className="h-3.5 w-3.5" /> : null}
            {t('inbox.activity.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function InboxModal() {
  const sharing = useExtensionsStore((s) => s.conversationSharing);
  const t = useT();
  const open = useUIStore((s) => s.inboxOpen);
  const tab = useUIStore((s) => s.inboxTab);
  const setTab = useUIStore((s) => s.setInboxTab);
  const onClose = useUIStore((s) => s.closeInbox);
  // The activity tab mounts on first visit and stays mounted while the dialog is open.
  const [activityVisited, setActivityVisited] = useState(false);
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [notifications, setNotifications] = useState<PlatformNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingAll, setMarkingAll] = useState(false);
  const setNotificationCount = (count: number) => useWsStore.setState({ notificationCount: count });

  const loadInbox = useCallback(async () => {
    setLoading(true);
    try {
      const [shareItems, notificationPage, summary] = await Promise.all([
        api.fetchShares({ limit: 100 }),
        api.fetchNotifications({ limit: 100 }),
        api.fetchNotificationSummary(),
      ]);
      setShares(shareItems);
      setNotifications(notificationPage.notifications);
      setNotificationCount(summary.unread);
    } catch {
      // Keep the previous snapshot visible; the next open/reconnect retries.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadInbox();
    else setActivityVisited(false);
  }, [open, loadInbox]);

  useEffect(() => {
    if (open && tab === 'activity') setActivityVisited(true);
  }, [open, tab]);

  const unreadShares = shares.filter((item) => !item.read_at).length;
  const unreadNotifications = notifications.filter((item) => !item.read_at).length;
  const activeUnread = tab === 'notifications' ? unreadNotifications : tab === 'shares' ? unreadShares : 0;

  const openShare = async (share: ShareItem) => {
    if (!share.read_at) {
      try {
        await api.markShareRead(share.id);
        setShares((previous) =>
          previous.map((item) => (item.id === share.id ? { ...item, read_at: new Date().toISOString() } : item)),
        );
      } catch {
        // Navigation is still safe; read state can retry next time.
      }
    }
    onClose();
    window.location.hash = `#/chat?session=${share.session_id}`;
  };

  const openNotification = async (item: PlatformNotification) => {
    let current = item;
    if (!item.read_at) {
      try {
        current = await api.markNotificationRead(item.id);
        setNotifications((previous) => previous.map((entry) => (entry.id === item.id ? current : entry)));
        setNotificationCount(Math.max(0, unreadNotifications - 1));
      } catch {
        // Preserve the notification and allow the deep link below.
      }
    }
    const href = notificationHref(current);
    if (href) {
      onClose();
      window.location.hash = href;
    }
  };

  const markAllRead = async () => {
    setMarkingAll(true);
    try {
      const now = new Date().toISOString();
      if (tab === 'notifications') {
        await api.markAllNotificationsRead();
        setNotifications((previous) => previous.map((item) => (item.read_at ? item : { ...item, read_at: now })));
        setNotificationCount(0);
      } else {
        await api.markAllSharesRead();
        setShares((previous) => previous.map((item) => (item.read_at ? item : { ...item, read_at: now })));
      }
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('inbox.title')} size="md" noPadding>
      <div className="flex flex-col">
        <div className="flex items-center gap-1 border-b border-edge px-3 pt-2" role="tablist">
          {(
            [
              ['notifications', t('inbox.notifications'), unreadNotifications],
              ['shares', t('inbox.sharedWithMe'), unreadShares],
              ['activity', t('inbox.activityTab'), 0],
            ] as Array<[InboxTab, string, number]>
          )
            .filter(([value]) => sharing || value !== 'shares')
            .map(([value, label, unread]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={`flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-xs transition-colors ${
                  tab === value
                    ? 'border-accent text-primary-fg-strong'
                    : 'border-transparent text-fg-muted hover:text-fg-secondary'
                }`}
              >
                {label}
                {unread > 0 && <Badge variant="destructive">{unread > 99 ? '99+' : unread}</Badge>}
              </button>
            ))}
          {tab !== 'activity' && (
            <button
              type="button"
              onClick={() => void markAllRead()}
              disabled={activeUnread === 0 || markingAll}
              className="ml-auto mb-1 inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg-secondary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <CheckCheck size={14} />
              {t('inbox.markAllRead')}
            </button>
          )}
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-3">
          {activityVisited && (
            <div hidden={tab !== 'activity'}>
              <TeamActivityTab onNavigate={onClose} />
            </div>
          )}

          {loading && tab !== 'activity' && (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          )}

          {!loading && tab === 'notifications' && notifications.length === 0 && (
            <EmptyState
              icon={Inbox}
              variant="compact"
              tone="neutral"
              title={t('inbox.noNotifications')}
              description={t('inbox.noNotificationsDesc')}
            />
          )}
          {!loading && tab === 'shares' && shares.length === 0 && (
            <EmptyState
              icon={Users}
              variant="compact"
              tone="neutral"
              title={t('inbox.noShares')}
              description={t('inbox.noSharesDesc')}
            />
          )}

          {!loading && tab === 'notifications' && notifications.length > 0 && (
            <div className="space-y-1.5">
              {notifications.map((item) => {
                const copy = notificationCopy(t, item);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void openNotification(item)}
                    className={`flex w-full gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                      item.read_at
                        ? 'border-edge bg-surface-raised hover:border-edge-strong'
                        : 'border-primary-edge bg-primary-subtle hover:bg-primary-subtle-hover'
                    }`}
                  >
                    <span className="mt-1.5 w-2 flex-shrink-0">
                      {!item.read_at && <span className="block h-2 w-2 rounded-full bg-accent" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-sm ${item.read_at ? 'text-fg-secondary' : 'font-medium text-fg'}`}
                      >
                        {copy.title}
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-fg-muted">
                        {markdownPreview(copy.body)}
                      </span>
                    </span>
                    <span className="flex-shrink-0 text-caption text-fg-faint">{timeAgo(item.created_at)}</span>
                  </button>
                );
              })}
            </div>
          )}

          {!loading && tab === 'shares' && shares.length > 0 && (
            <div className="space-y-1.5">
              {shares.map((share) => (
                <button
                  key={share.id}
                  type="button"
                  onClick={() => void openShare(share)}
                  className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                    share.read_at
                      ? 'border-edge bg-surface-raised hover:border-edge-strong'
                      : 'border-primary-edge bg-primary-subtle hover:bg-primary-subtle-hover'
                  }`}
                >
                  <span className="w-2 flex-shrink-0">
                    {!share.read_at && <span className="block h-2 w-2 rounded-full bg-accent" />}
                  </span>
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-surface-muted">
                    {share.shared_with === '__team__' ? <Users size={14} /> : <MessageSquare size={14} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm ${share.read_at ? 'text-fg-secondary' : 'font-medium text-fg'}`}
                    >
                      {share.session_title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-fg-muted">
                      <strong>{share.shared_by_nickname}</strong> {t('inbox.sharedYouSuffix')}
                      {share.message ? ` · “${share.message}”` : ''}
                    </span>
                  </span>
                  <span className="flex-shrink-0 text-caption text-fg-faint">{timeAgo(share.created_at)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {tab === 'activity' && (
          <div className="flex justify-end border-t border-edge px-4 py-2">
            <a href={ACTIVITY_ROOT_HASH} onClick={onClose} className="text-xs text-fg-muted hover:text-fg">
              {t('inbox.activity.viewAll')}
            </a>
          </div>
        )}
      </div>
    </Dialog>
  );
}
