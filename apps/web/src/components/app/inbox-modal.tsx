/**
 * InboxModal — 收件箱弹框
 *
 * Presents the shares list ("分享给我的会话") in a dialog instead of a full page.
 * Opened from the sidebar account menu. Supports per-item read on click and a
 * "全部已读" action. Marking read hits the backend, which pushes an updated
 * share:count over WebSocket — keeping the avatar badge in sync automatically.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Dialog, Spinner, Badge } from '../ui';
import { Inbox, MessageSquare, Users, CheckCheck } from '../../lib/icons';
import { timeAgo } from '../../lib/utils';
import { useT } from '../../lib/i18n';
import * as api from '../../lib/api';
import type { ShareItem } from '@greenhouse/types/api';

export function InboxModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingAll, setMarkingAll] = useState(false);

  const loadShares = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.fetchShares({ limit: 100 });
      setShares(list);
    } catch (_err) {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) loadShares();
  }, [open, loadShares]);

  const handleClick = async (share: ShareItem) => {
    if (!share.read_at) {
      try {
        await api.markShareRead(share.id);
        setShares((prev) => prev.map((s) => (s.id === share.id ? { ...s, read_at: new Date().toISOString() } : s)));
      } catch (_err) {
        /* ignore */
      }
    }
    onClose();
    window.location.hash = `#/chat?session=${share.session_id}`;
  };

  const handleMarkAllRead = async () => {
    setMarkingAll(true);
    try {
      await api.markAllSharesRead();
      const now = new Date().toISOString();
      setShares((prev) => prev.map((s) => (s.read_at ? s : { ...s, read_at: now })));
    } catch (_err) {
      /* ignore */
    }
    setMarkingAll(false);
  };

  const unreadCount = shares.filter((s) => !s.read_at).length;

  return (
    <Dialog open={open} onClose={onClose} title={t('inbox.title')} size="md" noPadding>
      <div className="flex flex-col">
        {/* Header actions */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-edge">
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <Inbox size={14} className="text-primary-600" />
            <span>{t('inbox.sharedWithMe')}</span>
            {unreadCount > 0 && (
              <Badge variant="destructive" className="text-[10px]">
                {t('inbox.unreadCount', { count: unreadCount })}
              </Badge>
            )}
          </div>
          <button
            onClick={handleMarkAllRead}
            disabled={unreadCount === 0 || markingAll}
            className="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md text-fg-muted hover:text-fg-secondary hover:bg-surface-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fg-muted"
          >
            <CheckCheck size={14} />
            <span>{t('inbox.markAllRead')}</span>
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto p-3">
          {loading && (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          )}

          {!loading && shares.length === 0 && (
            <div className="text-center py-12">
              <div className="w-12 h-12 rounded-2xl bg-surface-muted flex items-center justify-center mx-auto mb-3">
                <Inbox size={24} className="text-fg-faint" />
              </div>
              <p className="text-sm text-fg-muted">{t('inbox.noShares')}</p>
              <p className="text-xs text-fg-faint mt-1">{t('inbox.noSharesDesc')}</p>
            </div>
          )}

          {!loading && shares.length > 0 && (
            <div className="space-y-1.5">
              {shares.map((s) => (
                <button
                  key={s.id}
                  onClick={() => handleClick(s)}
                  className={`w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                    s.read_at
                      ? 'bg-surface-raised border-edge hover:border-edge-strong'
                      : 'bg-primary-50/50 border-primary-200 hover:bg-primary-50'
                  }`}
                >
                  {/* Unread dot */}
                  <div className="flex-shrink-0 w-2">
                    {!s.read_at && <div className="w-2 h-2 rounded-full bg-primary-500" />}
                  </div>
                  {/* Icon */}
                  <div className="w-8 h-8 rounded-full bg-surface-muted flex items-center justify-center flex-shrink-0">
                    {s.shared_with === '__team__' ? (
                      <Users size={14} className="text-fg-muted" />
                    ) : (
                      <MessageSquare size={14} className="text-fg-muted" />
                    )}
                  </div>
                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-sm truncate ${s.read_at ? 'text-fg-secondary' : 'font-medium text-fg'}`}
                        title={s.session_title}
                      >
                        {s.session_title}
                      </span>
                      {s.shared_with === '__team__' && (
                        <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                          Team
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-fg-muted mt-0.5 truncate">
                      <span className="font-medium">{s.shared_by_nickname}</span> {t('inbox.sharedYouSuffix')}
                      {s.message && <span className="text-fg-faint"> · “{s.message}”</span>}
                    </div>
                  </div>
                  {/* Time */}
                  <span className="text-[11px] text-fg-faint flex-shrink-0">{timeAgo(s.created_at)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
