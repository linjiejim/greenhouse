/**
 * ShareDialog — share a session with team members.
 *
 * Supports sharing with specific users or the entire team.
 * Shows existing shares with individual removal buttons.
 * Displays total viewer count in header.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Dialog, Button, Input, Spinner, Badge, Toggle, Textarea, toast } from '../ui';
import { Share2, X, Users, Check } from '../../lib/icons';
import * as api from '../../lib/api';
import type { ShareableUser, ShareItem } from '@greenhouse/types/api';
import { timeAgo } from '../../lib/utils';

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  sessionTitle: string;
  /** Called after a share change so the parent can refresh share_count. */
  onShareChanged?: () => void;
}

export function ShareDialog({ open, onClose, sessionId, sessionTitle, onShareChanged }: ShareDialogProps) {
  const [users, setUsers] = useState<ShareableUser[]>([]);
  const [existingShares, setExistingShares] = useState<ShareItem[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [shareWithTeam, setShareWithTeam] = useState(false);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState('');

  // Load users and existing shares
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([api.fetchShareableUsers(), api.getSessionShares(sessionId)])
      .then(([userList, shares]) => {
        setUsers(userList);
        setExistingShares(shares);
        // Check if already shared with team
        if (shares.some((s) => s.shared_with === '__team__')) {
          setShareWithTeam(true);
        }
      })
      .finally(() => setLoading(false));
  }, [open, sessionId]);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedUserIds(new Set());
      setShareWithTeam(false);
      setNote('');
      setSearch('');
    }
  }, [open]);

  const handleToggleUser = useCallback((userId: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }, []);

  const handleShare = useCallback(async () => {
    if (selectedUserIds.size === 0 && !shareWithTeam) return;

    setSubmitting(true);
    try {
      await api.shareSession(sessionId, {
        user_ids: selectedUserIds.size > 0 ? Array.from(selectedUserIds) : undefined,
        team: shareWithTeam,
        message: note.trim() || undefined,
      });
      toast('Session shared successfully', 'success');
      onShareChanged?.();
      onClose();
    } catch (err: any) {
      toast(err.message || 'Failed to share', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [sessionId, selectedUserIds, shareWithTeam, note, onClose, onShareChanged]);

  const handleUnshareAll = useCallback(async () => {
    try {
      await api.unshareSession(sessionId);
      toast('All sharing removed', 'success');
      setExistingShares([]);
      setShareWithTeam(false);
      onShareChanged?.();
    } catch {
      toast('Failed to remove sharing', 'error');
    }
  }, [sessionId, onShareChanged]);

  const handleRemoveOne = useCallback(
    async (shareId: number) => {
      try {
        await api.deleteOneShare(sessionId, shareId);
        setExistingShares((prev) => prev.filter((s) => s.id !== shareId));
        toast('Share removed', 'success');
        onShareChanged?.();
      } catch {
        toast('Failed to remove share', 'error');
      }
    },
    [sessionId, onShareChanged],
  );

  // Filter users by search
  const filteredUsers = users.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return u.nickname.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  // Already-shared user IDs
  const alreadySharedUserIds = new Set(
    existingShares.filter((s) => s.shared_with !== '__team__').map((s) => s.shared_with),
  );
  const isTeamShared = existingShares.some((s) => s.shared_with === '__team__');

  // Compute viewer count for display
  const viewerCount = isTeamShared
    ? users.length // team = all internal users
    : alreadySharedUserIds.size;

  return (
    <Dialog open={open} onClose={onClose} title="Share Conversation" size="md">
      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Session title + viewer count */}
          <div className="flex items-center justify-between">
            <div className="text-sm text-fg-secondary min-w-0">
              <span className="text-fg-muted">Sharing: </span>
              <span className="font-medium truncate">{sessionTitle || 'Untitled'}</span>
            </div>
            {viewerCount > 0 && (
              <div className="flex items-center gap-1 text-xs text-fg-muted flex-shrink-0 bg-surface-muted px-2 py-1 rounded-full">
                <Users size={12} />
                <span>{isTeamShared ? 'Team' : `${viewerCount} viewer${viewerCount !== 1 ? 's' : ''}`}</span>
              </div>
            )}
          </div>

          {/* Existing shares */}
          {existingShares.length > 0 && (
            <div className="bg-surface-muted rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-fg-muted uppercase tracking-wider">
                  Currently shared with
                </span>
                <button onClick={handleUnshareAll} className="text-xs text-danger hover:underline">
                  Remove all
                </button>
              </div>
              <div className="space-y-1">
                {isTeamShared && (
                  <div className="flex items-center justify-between py-1">
                    <Badge variant="secondary">
                      <Users size={10} className="mr-1" />
                      Entire Team
                    </Badge>
                    {existingShares.find((s) => s.shared_with === '__team__') && (
                      <button
                        onClick={() => handleRemoveOne(existingShares.find((s) => s.shared_with === '__team__')!.id)}
                        className="p-0.5 text-fg-faint hover:text-danger transition-colors"
                        title="Remove team share"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                )}
                {existingShares
                  .filter((s) => s.shared_with !== '__team__')
                  .map((s) => {
                    const user = users.find((u) => u.id === s.shared_with);
                    return (
                      <div key={s.id} className="flex items-center justify-between py-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge variant="default">{user?.nickname || 'Unknown'}</Badge>
                          <span className="text-[10px] text-fg-faint">{timeAgo(s.created_at)}</span>
                        </div>
                        <button
                          onClick={() => handleRemoveOne(s.id)}
                          className="p-0.5 text-fg-faint hover:text-danger transition-colors"
                          title={`Remove share for ${user?.nickname || 'Unknown'}`}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    );
                  })}
              </div>
              {existingShares[0]?.message && (
                <p className="text-xs text-fg-muted italic">"{existingShares[0].message}"</p>
              )}
            </div>
          )}

          {/* Share with team toggle */}
          <div className="flex items-center justify-between py-2 border-b border-edge">
            <div className="flex items-center gap-2">
              <Users size={16} className="text-fg-muted" />
              <div>
                <span className="text-sm font-medium text-fg">Share with entire team</span>
                <p className="text-xs text-fg-muted">All internal users can view this conversation</p>
              </div>
            </div>
            <Toggle checked={shareWithTeam} onChange={setShareWithTeam} disabled={isTeamShared} />
          </div>

          {/* User selection */}
          {!shareWithTeam && (
            <>
              <div>
                <Input
                  placeholder="Search team members..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  size="sm"
                />
              </div>
              <div className="max-h-48 overflow-y-auto border border-edge rounded-lg divide-y divide-edge">
                {filteredUsers.length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-fg-muted">No members found</div>
                )}
                {filteredUsers.map((user) => {
                  const isAlready = alreadySharedUserIds.has(user.id);
                  const isSelected = selectedUserIds.has(user.id);
                  return (
                    <button
                      key={user.id}
                      onClick={() => !isAlready && handleToggleUser(user.id)}
                      disabled={isAlready}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                        isAlready
                          ? 'opacity-50 cursor-default'
                          : isSelected
                            ? 'bg-primary-subtle'
                            : 'hover:bg-surface-muted'
                      }`}
                    >
                      {/* Checkbox */}
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                          isSelected || isAlready ? 'bg-primary-500 border-primary-500' : 'border-edge-strong'
                        }`}
                      >
                        {(isSelected || isAlready) && <Check size={10} className="text-white" />}
                      </div>
                      {/* Avatar */}
                      <div className="w-7 h-7 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center text-xs font-semibold flex-shrink-0">
                        {user.nickname.charAt(0).toUpperCase()}
                      </div>
                      {/* Info */}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{user.nickname}</div>
                        <div className="text-[11px] text-fg-muted truncate">{user.email}</div>
                      </div>
                      {isAlready && <span className="text-[10px] text-fg-faint">Shared</span>}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* Note */}
          <div>
            <Textarea
              placeholder="Add a note (optional)..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="text-sm"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleShare} disabled={submitting || (selectedUserIds.size === 0 && !shareWithTeam)}>
              {submitting ? (
                <Spinner className="w-4 h-4" />
              ) : (
                <>
                  <Share2 size={14} className="mr-1.5" />
                  Share
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
