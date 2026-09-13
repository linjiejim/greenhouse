/** Unified Inbox — platform notifications and sessions shared with me. */

import React, { useCallback, useEffect, useState } from 'react';
import type { ShareItem } from '@greenhouse/types/api';
import type { PlatformNotification } from '@greenhouse/types/notification';

import { CheckCheck, Inbox, MessageSquare, Users } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { executionNotificationHref } from '../../lib/execution-route';
import { timeAgo, markdownPreview } from '../../lib/utils';
import * as api from '../../lib/api';
import { useWsStore } from '../../stores';
import { Badge, Dialog, EmptyState, Spinner } from '../ui';

type InboxTab = 'notifications' | 'shares';

function notificationHref(item: PlatformNotification): string | null {
  if (item.run_id) {
    // Historical notifications predate the kind segment; the Execution Center
    // router keeps this compatibility form readable.
    return executionNotificationHref(item.run_id, item.payload);
  }
  if (item.agent_id) return '#/agents';
  return null;
}

export function InboxModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<InboxTab>('notifications');
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
  }, [open, loadInbox]);

  const unreadShares = shares.filter((item) => !item.read_at).length;
  const unreadNotifications = notifications.filter((item) => !item.read_at).length;
  const activeUnread = tab === 'notifications' ? unreadNotifications : unreadShares;

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
            ] as const
          ).map(([value, label, unread]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs transition-colors ${
                tab === value
                  ? 'border-primary-500 text-primary-fg-strong'
                  : 'border-transparent text-fg-muted hover:text-fg-secondary'
              }`}
            >
              {label}
              {unread > 0 && <Badge variant="destructive">{unread > 99 ? '99+' : unread}</Badge>}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={activeUnread === 0 || markingAll}
            className="ml-auto mb-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg-secondary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CheckCheck size={14} />
            {t('inbox.markAllRead')}
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-3">
          {loading && (
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
              {notifications.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void openNotification(item)}
                  className={`flex w-full gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    item.read_at
                      ? 'border-edge bg-surface-raised hover:border-edge-strong'
                      : 'border-primary-edge bg-primary-subtle hover:bg-primary-subtle-hover'
                  }`}
                >
                  <span className="mt-1.5 w-2 flex-shrink-0">
                    {!item.read_at && <span className="block h-2 w-2 rounded-full bg-primary-500" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm ${item.read_at ? 'text-fg-secondary' : 'font-medium text-fg'}`}
                    >
                      {item.title}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-fg-muted">
                      {markdownPreview(item.body)}
                    </span>
                  </span>
                  <span className="flex-shrink-0 text-[11px] text-fg-faint">{timeAgo(item.created_at)}</span>
                </button>
              ))}
            </div>
          )}

          {!loading && tab === 'shares' && shares.length > 0 && (
            <div className="space-y-1.5">
              {shares.map((share) => (
                <button
                  key={share.id}
                  type="button"
                  onClick={() => void openShare(share)}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    share.read_at
                      ? 'border-edge bg-surface-raised hover:border-edge-strong'
                      : 'border-primary-edge bg-primary-subtle hover:bg-primary-subtle-hover'
                  }`}
                >
                  <span className="w-2 flex-shrink-0">
                    {!share.read_at && <span className="block h-2 w-2 rounded-full bg-primary-500" />}
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
                  <span className="flex-shrink-0 text-[11px] text-fg-faint">{timeAgo(share.created_at)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
