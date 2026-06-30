/**
 * Inbox page — #/inbox
 *
 * Shows all sessions shared with the current user.
 * Unread shares are highlighted. Replaces the old Mentions page.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Spinner, Badge } from '../components/ui';
import { Inbox, MessageSquare, Users } from '../lib/icons';
import { timeAgo } from '../lib/utils';
import * as api from '../lib/api';
import type { ShareItem } from '@greenhouse/types/api';

export function InboxPage() {
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [loading, setLoading] = useState(true);

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
    loadShares();
  }, [loadShares]);

  const handleClick = async (share: ShareItem) => {
    // Mark as read
    if (!share.read_at) {
      try {
        await api.markShareRead(share.id);
        setShares((prev) => prev.map((s) => (s.id === share.id ? { ...s, read_at: new Date().toISOString() } : s)));
      } catch (_err) {
        /* ignore */
      }
    }
    // Navigate to the session
    window.location.hash = `#/chat?session=${share.session_id}`;
  };

  const unreadCount = shares.filter((s) => !s.read_at).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-fg flex items-center gap-2">
              <Inbox size={20} className="text-primary-600" />
              Inbox
              {unreadCount > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {unreadCount} new
                </Badge>
              )}
            </h1>
            <p className="text-xs text-fg-muted mt-0.5">Conversations shared with you</p>
          </div>
        </div>

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
            <p className="text-sm text-fg-muted">No shared conversations</p>
            <p className="text-xs text-fg-faint mt-1">
              When someone shares a conversation with you, it will appear here
            </p>
          </div>
        )}

        {!loading && shares.length > 0 && (
          <div className="space-y-1.5">
            {shares.map((s) => (
              <button
                key={s.id}
                onClick={() => handleClick(s)}
                className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${
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
                  <div className="text-xs text-fg-muted mt-0.5">
                    <span className="font-medium">{s.shared_by_nickname}</span> shared with you
                    {s.message && <span className="text-fg-faint"> · "{s.message}"</span>}
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
  );
}
