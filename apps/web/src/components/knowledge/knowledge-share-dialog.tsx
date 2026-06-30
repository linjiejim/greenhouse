/**
 * KnowledgeShareDialog — share a PRIVATE knowledge doc with specific people or
 * groups, at reader or editor level. Owner-only (the page gates the entry point).
 *
 * Mirrors the session ShareDialog but adds role + group targets, matching the
 * knowledge_base_shares model (shared_with = user_id | 'group:<id>').
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Dialog, Button, Input, Spinner, Badge, Select, toast } from '../ui';
import { Share2, X, Users, Check, Lock } from '../../lib/icons';
import { fetchShareableUsers } from '../../lib/api';
import { listGroups } from '../../lib/api/groups';
import { listKnowledgeShares, shareKnowledgeDoc, revokeKnowledgeShare } from '../../lib/api/knowledge';
import { useT } from '../../lib/i18n';
import type { ShareableUser, UserGroup, KnowledgeShare } from '@greenhouse/types/api';

interface KnowledgeShareDialogProps {
  open: boolean;
  onClose: () => void;
  docId: number;
  docTitle: string;
  onChanged?: () => void;
}

export function KnowledgeShareDialog({ open, onClose, docId, docTitle, onChanged }: KnowledgeShareDialogProps) {
  const t = useT();
  const [users, setUsers] = useState<ShareableUser[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [shares, setShares] = useState<KnowledgeShare[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<number>>(new Set());
  const [role, setRole] = useState<'reader' | 'editor'>('reader');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const reloadShares = useCallback(() => {
    listKnowledgeShares(docId)
      .then(setShares)
      .catch(() => setShares([]));
  }, [docId]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSelectedUsers(new Set());
    setSelectedGroups(new Set());
    setRole('reader');
    setSearch('');
    Promise.all([fetchShareableUsers(), listGroups(), listKnowledgeShares(docId)])
      .then(([u, g, s]) => {
        setUsers(u);
        setGroups(g);
        setShares(s);
      })
      .catch(() => toast(t('knowledge.loadShareFailed'), 'error'))
      .finally(() => setLoading(false));
  }, [open, docId]);

  const sharedTargets = new Set(shares.map((s) => s.target));

  const handleShare = async () => {
    if (selectedUsers.size === 0 && selectedGroups.size === 0) return;
    setSubmitting(true);
    try {
      await shareKnowledgeDoc(docId, {
        user_ids: selectedUsers.size > 0 ? Array.from(selectedUsers) : undefined,
        group_ids: selectedGroups.size > 0 ? Array.from(selectedGroups) : undefined,
        role,
      });
      toast(t('knowledge.shareSuccess'), 'success');
      setSelectedUsers(new Set());
      setSelectedGroups(new Set());
      reloadShares();
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.shareFailed'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async (target: string) => {
    try {
      await revokeKnowledgeShare(docId, target);
      setShares((prev) => prev.filter((s) => s.target !== target));
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.revokeFailed'), 'error');
    }
  };

  const filteredUsers = users.filter(
    (u) =>
      !search ||
      u.nickname.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()),
  );

  const toggle = <T,>(set: Set<T>, value: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set);
    next.has(value) ? next.delete(value) : next.add(value);
    apply(next);
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('knowledge.shareDocTitle')} size="md">
      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-fg-secondary">
            <Lock size={14} className="text-fg-faint" />
            <span className="text-fg-muted">{t('knowledge.sharingLabel')}</span>
            <span className="font-medium truncate">{docTitle || t('common.untitled')}</span>
          </div>

          {/* Existing grants */}
          {shares.length > 0 && (
            <div className="bg-surface-muted rounded-lg p-3 space-y-1">
              <span className="text-xs font-medium text-fg-muted uppercase tracking-wider">
                {t('knowledge.sharedWith')}
              </span>
              {shares.map((s) => (
                <div key={s.target} className="flex items-center justify-between py-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant={s.kind === 'group' ? 'secondary' : 'default'}>
                      {s.kind === 'group' && <Users size={10} className="mr-1" />}
                      {s.name}
                    </Badge>
                    <span className="text-[10px] text-fg-faint">
                      {s.role === 'editor' ? t('knowledge.editable') : t('knowledge.readOnly')}
                    </span>
                  </div>
                  <button
                    onClick={() => handleRevoke(s.target)}
                    className="p-0.5 text-fg-faint hover:text-danger transition-colors"
                    title={t('knowledge.revoke')}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Role */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-fg-muted">{t('knowledge.permission')}</span>
            <Select size="sm" inline value={role} onChange={(e) => setRole(e.target.value as 'reader' | 'editor')}>
              <option value="reader">{t('knowledge.roleReader')}</option>
              <option value="editor">{t('knowledge.roleEditor')}</option>
            </Select>
          </div>

          {/* Groups */}
          <div>
            <span className="text-xs font-medium text-fg-muted">{t('knowledge.groups')}</span>
            {groups.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {groups.map((g) => {
                  const target = `group:${g.id}`;
                  const already = sharedTargets.has(target);
                  const selected = selectedGroups.has(g.id);
                  return (
                    <button
                      key={g.id}
                      disabled={already}
                      onClick={() => toggle(selectedGroups, g.id, setSelectedGroups)}
                      className={`text-xs px-2 py-1 rounded-full border transition-colors flex items-center gap-1 ${
                        already
                          ? 'opacity-40 cursor-default border-edge'
                          : selected
                            ? 'bg-primary-subtle border-primary-300 text-primary-fg-strong'
                            : 'border-edge hover:bg-surface-muted'
                      }`}
                    >
                      <Users size={11} />
                      {g.name}
                      {g.member_count !== undefined && <span className="text-fg-faint">({g.member_count})</span>}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="mt-1 text-xs text-fg-muted">
                {t('knowledge.noGroupsHint')}{' '}
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    window.location.hash = '#/settings/groups';
                  }}
                  className="text-primary-fg-strong hover:underline"
                >
                  {t('knowledge.createGroupLink')}
                </button>
              </p>
            )}
          </div>

          {/* Users */}
          <div>
            <Input
              placeholder={t('knowledge.searchMembers')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="sm"
            />
            <div className="mt-2 max-h-48 overflow-y-auto border border-edge rounded-lg divide-y divide-edge">
              {filteredUsers.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-fg-muted">{t('knowledge.noMembers')}</div>
              )}
              {filteredUsers.map((u) => {
                const already = sharedTargets.has(u.id);
                const selected = selectedUsers.has(u.id);
                return (
                  <button
                    key={u.id}
                    disabled={already}
                    onClick={() => toggle(selectedUsers, u.id, setSelectedUsers)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                      already ? 'opacity-50 cursor-default' : selected ? 'bg-primary-subtle' : 'hover:bg-surface-muted'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                        selected || already ? 'bg-primary-500 border-primary-500' : 'border-edge-strong'
                      }`}
                    >
                      {(selected || already) && <Check size={10} className="text-white" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{u.nickname}</div>
                      <div className="text-[11px] text-fg-muted truncate">{u.email}</div>
                    </div>
                    {already && <span className="text-[10px] text-fg-faint">{t('knowledge.alreadyShared')}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button
              onClick={handleShare}
              disabled={submitting || (selectedUsers.size === 0 && selectedGroups.size === 0)}
            >
              {submitting ? <Spinner className="w-4 h-4" /> : <Share2 size={14} className="mr-1.5" />}
              {t('knowledge.share')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
