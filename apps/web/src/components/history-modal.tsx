/**
 * FullHistoryModal — full-screen session history browser with filters, search, and inline actions.
 * Extracted from history-sidebar.tsx to keep file sizes manageable.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Dialog,
  Input,
  Select,
  Textarea,
  Badge,
  Spinner,
  Button,
  StarRating,
  EmptyState,
  ConfirmDialog,
  toast,
} from './ui';
import {
  FlaskConical,
  Package,
  Trash2,
  ThumbsUp,
  ThumbsDown,
  Star,
  Pencil,
  RotateCcw,
  Archive,
  Inbox,
  Tag,
  Share2,
} from '../lib/icons';
import type { LucideIcon } from '../lib/icons';
import * as api from '../lib/api';
import { useT } from '../lib/i18n';
import { TagBadge, TagFilter, TagManagerDialog } from './session-tags';
import type { SessionTag, SessionGroup } from '@greenhouse/types/api';

const PAGE_SIZE = 20;

export function FullHistoryModal({
  open,
  onClose,
  onSelectSession,
}: {
  open: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
}) {
  const t = useT();
  const [allSessions, setAllSessions] = useState<api.Session[]>([]);
  const [statusFilter, setStatusFilter] = useState('active');
  const [feedbackFilter, setFeedbackFilter] = useState<'all' | 'good' | 'bad' | 'starred'>('all');
  const [profileFilter, setProfileFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState<'all' | 'mine' | 'shared'>('all');
  const [ratingFilter, setRatingFilter] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<api.Session | null>(null);
  const [page, setPage] = useState(0);
  const [editSession, setEditSession] = useState<api.Session | null>(null);
  const [commentText, setCommentText] = useState('');
  const [ratingValue, setRatingValue] = useState(0);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [allTags, setAllTags] = useState<SessionTag[]>([]);
  const [activeTagFilter, setActiveTagFilter] = useState<number | null>(null);
  const [showTagManager, setShowTagManager] = useState(false);
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  // 'all' | 'pinned' | 'ungrouped' | 'g:<id>'
  const [orgFilter, setOrgFilter] = useState<string>('all');

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const [data, profileData, tagsData, groupsData] = await Promise.all([
        api.listSessions(),
        api.fetchProfiles(),
        api.listSessionTags(),
        api.listSessionGroups(),
      ]);
      setAllSessions(data);
      setProfiles(profileData);
      setAllTags(tagsData);
      setGroups(groupsData);
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) loadSessions();
  }, [open, loadSessions]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of allSessions) {
      counts[s.status] = (counts[s.status] || 0) + 1;
    }
    return counts;
  }, [allSessions]);

  const feedbackCounts = useMemo(() => {
    const counts: Record<string, number> = { good: 0, bad: 0, starred: 0 };
    for (const s of allSessions) {
      if (s.feedback && counts[s.feedback] !== undefined) counts[s.feedback]++;
    }
    return counts;
  }, [allSessions]);

  const filteredSessions = useMemo(() => {
    let result = allSessions;
    result = result.filter((s) => s.status === statusFilter);
    if (feedbackFilter !== 'all') {
      result = result.filter((s) => s.feedback === feedbackFilter);
    }
    if (profileFilter !== 'all') {
      result = result.filter((s) => (s.profile_id || 'default') === profileFilter);
    }
    if (ownerFilter === 'mine') {
      result = result.filter((s) => s.is_owner !== false);
    } else if (ownerFilter === 'shared') {
      result = result.filter((s) => s.shared === true);
    }
    if (ratingFilter != null) {
      result = result.filter((s) => s.rating === ratingFilter);
    }
    if (activeTagFilter != null) {
      result = result.filter((s) => (s as any).tags?.some((t: any) => t.id === activeTagFilter));
    }
    if (orgFilter === 'pinned') {
      result = result.filter((s) => s.pinned === true);
    } else if (orgFilter === 'ungrouped') {
      result = result.filter((s) => s.group_id == null);
    } else if (orgFilter.startsWith('g:')) {
      const gid = parseInt(orgFilter.slice(2), 10);
      result = result.filter((s) => s.group_id === gid);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) => (s.title || '').toLowerCase().includes(q) || (s.comment || '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [
    allSessions,
    statusFilter,
    feedbackFilter,
    profileFilter,
    ownerFilter,
    ratingFilter,
    activeTagFilter,
    orgFilter,
    search,
  ]);

  const paginatedSessions = useMemo(() => {
    return filteredSessions.slice(0, (page + 1) * PAGE_SIZE);
  }, [filteredSessions, page]);

  const hasMore = paginatedSessions.length < filteredSessions.length;

  const handleStatusChange = async (session: api.Session, newStatus: string) => {
    await api.updateSession(session.id, { status: newStatus });
    setAllSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, status: newStatus } : s)));
  };

  const handleFeedbackChange = async (session: api.Session, feedback: 'good' | 'bad' | 'starred' | null) => {
    await api.updateSession(session.id, { feedback });
    setAllSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, feedback } : s)));
  };

  const handleInlineRating = async (session: api.Session, rating: number) => {
    await api.updateSession(session.id, { rating });
    setAllSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, rating } : s)));
  };

  const handleOpenEdit = (session: api.Session) => {
    setEditSession(session);
    setCommentText(session.comment || '');
    setRatingValue(session.rating || 0);
  };

  const handleSaveEdit = async () => {
    if (!editSession) return;
    await api.updateSession(editSession.id, {
      comment: commentText || undefined,
      rating: ratingValue || undefined,
    });
    setAllSessions((prev) =>
      prev.map((s) => (s.id === editSession.id ? { ...s, comment: commentText, rating: ratingValue } : s)),
    );
    setEditSession(null);
  };

  const handleDelete = async (session: api.Session) => {
    if (session.status === 'deleted') {
      setPendingDeleteSession(session);
    } else {
      await api.updateSession(session.id, { status: 'deleted' });
      setAllSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, status: 'deleted' } : s)));
      toast(t('chat.sessionMovedToTrash'), 'info');
    }
  };

  const handleOpen = (session: api.Session) => {
    onSelectSession(session.id);
  };

  const STATUS_ITEMS: Array<{ key: string; label: string; icon: LucideIcon | null }> = [
    { key: 'active', label: 'Active', icon: null },
    { key: 'archived', label: 'Archived', icon: Package },
    { key: 'deleted', label: 'Deleted', icon: Trash2 },
    { key: 'eval', label: 'Eval', icon: FlaskConical },
  ];

  const FEEDBACK_ITEMS: Array<{ key: 'all' | 'good' | 'bad' | 'starred'; label: string; icon: LucideIcon | null }> = [
    { key: 'all' as const, label: 'All', icon: null },
    { key: 'good' as const, label: 'Good', icon: ThumbsUp },
    { key: 'bad' as const, label: 'Bad', icon: ThumbsDown },
    { key: 'starred' as const, label: 'Starred', icon: Star },
  ];

  const getStatusBadge = (status: string) => {
    const map: Record<
      string,
      { variant: 'default' | 'success' | 'warning' | 'destructive' | 'secondary'; label: string; icon?: LucideIcon }
    > = {
      active: { variant: 'success', label: 'active' },
      eval: { variant: 'secondary', label: 'eval', icon: FlaskConical },
      archived: { variant: 'warning', label: 'archived' },
      deleted: { variant: 'destructive', label: 'deleted' },
    };
    const info = map[status] || { variant: 'secondary' as const, label: status };
    return (
      <Badge variant={info.variant}>
        {info.icon ? React.createElement(info.icon, { size: 10, className: 'mr-0.5 inline' }) : null}
        {info.label}
      </Badge>
    );
  };

  const getFeedbackBadge = (session: api.Session) => {
    if (!session.feedback) return null;
    const map: Record<string, { variant: 'default' | 'success' | 'destructive'; icon: LucideIcon }> = {
      good: { variant: 'success', icon: ThumbsUp },
      bad: { variant: 'destructive', icon: ThumbsDown },
      starred: { variant: 'default', icon: Star },
    };
    const info = map[session.feedback];
    if (!info) return null;
    return (
      <Badge variant={info.variant}>
        <info.icon size={10} />
      </Badge>
    );
  };

  if (!open) return null;

  return (
    <>
      <Dialog open={open} onClose={onClose} title="History" size="xl" noPadding>
        {/* Filters */}
        <div className="px-4 md:px-6 py-3 border-b border-edge bg-surface-sunken/50 space-y-2 flex-shrink-0">
          {/* Status filter */}
          <div className="flex gap-1 bg-surface-muted p-1 rounded-lg overflow-x-auto scrollbar-hide">
            {STATUS_ITEMS.map((item) => {
              const count = statusCounts[item.key] || 0;
              return (
                <button
                  key={item.key}
                  onClick={() => {
                    setStatusFilter(item.key);
                    setPage(0);
                  }}
                  className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap ${
                    statusFilter === item.key
                      ? 'bg-surface-raised text-primary-fg-strong font-medium shadow-sm'
                      : 'text-fg-muted hover:text-fg-secondary'
                  }`}
                >
                  {item.icon && <span className="text-xs">{React.createElement(item.icon, { size: 12 })}</span>}
                  <span>{item.label}</span>
                  {count > 0 && <span className="text-[10px] ml-0.5 text-fg-faint">({count})</span>}
                </button>
              );
            })}
          </div>

          {/* Feedback + search + filters */}
          <div className="flex flex-col md:flex-row gap-2 md:items-center">
            {/* Feedback filter */}
            <div className="flex gap-1 items-center">
              <span className="text-[11px] text-fg-faint mr-1">Feedback:</span>
              {FEEDBACK_ITEMS.map((item) => {
                const count = item.key === 'all' ? null : feedbackCounts[item.key] || 0;
                return (
                  <button
                    key={item.key}
                    onClick={() => {
                      setFeedbackFilter(item.key);
                      setPage(0);
                    }}
                    className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap ${
                      feedbackFilter === item.key
                        ? 'bg-primary-subtle text-primary-fg-strong font-medium border border-primary-edge'
                        : 'text-fg-muted hover:text-fg-secondary border border-transparent hover:border-edge'
                    }`}
                  >
                    {item.icon && <span className="text-xs">{React.createElement(item.icon, { size: 12 })}</span>}
                    <span>{item.label}</span>
                    {count != null && count > 0 && <span className="text-[10px] ml-0.5 text-fg-faint">({count})</span>}
                  </button>
                );
              })}
            </div>

            {/* Search */}
            <div className="flex-1">
              <Input
                placeholder={t('chat.searchConversations')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {/* Ownership + Profile + Rating */}
            <div className="flex gap-2 items-center overflow-x-auto scrollbar-hide flex-shrink-0">
              <Select
                value={ownerFilter}
                onChange={(e) => {
                  setOwnerFilter(e.target.value as 'all' | 'mine' | 'shared');
                  setPage(0);
                }}
                className="flex-shrink-0 w-auto"
              >
                <option value="all">All conversations</option>
                <option value="mine">Owned by me</option>
                <option value="shared">Shared with me</option>
              </Select>
              <Select
                value={orgFilter}
                onChange={(e) => {
                  setOrgFilter(e.target.value);
                  setPage(0);
                }}
                className="flex-shrink-0 w-auto"
              >
                <option value="all">All groups</option>
                <option value="pinned">📌 Pinned</option>
                <option value="ungrouped">Ungrouped</option>
                {groups
                  .filter((g) => g.kind !== 'pinned')
                  .map((g) => (
                    <option key={g.id} value={`g:${g.id}`}>
                      {g.name}
                    </option>
                  ))}
              </Select>
              {profiles.length > 1 && (
                <Select
                  value={profileFilter}
                  onChange={(e) => {
                    setProfileFilter(e.target.value);
                    setPage(0);
                  }}
                  className="flex-shrink-0 w-auto"
                >
                  <option value="all">All Profiles</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
              <div className="flex items-center gap-1 bg-surface-raised border border-edge-strong rounded-md px-2 py-1.5 flex-shrink-0">
                <span className="text-[11px] text-fg-faint mr-1">
                  {ratingFilter != null ? `Rating (${ratingFilter}):` : 'Rating:'}
                </span>
                {[1, 2, 3, 4, 5].map((r) => (
                  <button
                    key={r}
                    onClick={() => setRatingFilter(ratingFilter === r ? null : r)}
                    className="transition-all hover:scale-110"
                    title={`Filter by ${r} star${r > 1 ? 's' : ''}`}
                  >
                    <Star
                      size={12}
                      className={`${ratingFilter === r ? 'text-yellow-400 fill-yellow-400' : 'text-fg-faint hover:text-yellow-400'}`}
                    />
                  </button>
                ))}
                {ratingFilter != null && (
                  <button
                    onClick={() => setRatingFilter(null)}
                    className="text-[10px] text-fg-faint hover:text-fg-secondary ml-1"
                    title="Clear rating filter"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Tag filter */}
          {allTags.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-fg-faint flex-shrink-0">Tags:</span>
              <TagFilter
                tags={allTags}
                activeTagId={activeTagFilter}
                onSelect={(id) => {
                  setActiveTagFilter(id);
                  setPage(0);
                }}
              />
              <button
                onClick={() => setShowTagManager(true)}
                className="p-1 text-fg-faint hover:text-fg-secondary rounded transition-colors flex-shrink-0"
                title="Manage Tags"
              >
                <Tag size={12} />
              </button>
            </div>
          )}
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto px-4 md:px-6 py-2">
          {loading && allSessions.length === 0 && (
            <div className="flex justify-center py-8">
              <Spinner className="h-6 w-6 text-fg-faint" />
            </div>
          )}

          {!loading && filteredSessions.length === 0 && (
            <EmptyState icon={Inbox} title="No conversations found" description={`No ${statusFilter} conversations`} />
          )}

          <div className="space-y-0.5">
            {paginatedSessions.map((session) => (
              <div
                key={session.id}
                className="bg-surface-raised border border-edge rounded-md px-3 py-2 hover:border-primary-300 hover:bg-primary-subtle/30 transition-colors cursor-pointer group"
                onClick={() => handleOpen(session)}
              >
                {/* Row 1 */}
                <div className="flex items-center gap-2 min-w-0">
                  <h3
                    className="text-sm text-fg truncate flex-1 min-w-0 font-medium"
                    title={session.title || 'Untitled'}
                  >
                    {session.title || 'Untitled'}
                  </h3>
                  {session.shared && (
                    <Badge variant="secondary">
                      <Share2 size={10} className="mr-0.5 inline" />
                      Shared
                    </Badge>
                  )}
                  <div className="flex items-center gap-0 flex-shrink-0">
                    <span className="hidden md:contents md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                      <ModalActionBtn
                        type="comment"
                        title="Comment"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenEdit(session);
                        }}
                      />
                      <ModalActionBtn
                        type={session.feedback === 'starred' ? 'star-fill' : 'star'}
                        title={session.feedback === 'starred' ? 'Unstar' : 'Star'}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFeedbackChange(session, session.feedback === 'starred' ? null : 'starred');
                        }}
                      />
                      <ModalActionBtn
                        type="thumbsup"
                        title="Good"
                        active={session.feedback === 'good'}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFeedbackChange(session, session.feedback === 'good' ? null : 'good');
                        }}
                      />
                      <ModalActionBtn
                        type="thumbsdown"
                        title="Bad"
                        active={session.feedback === 'bad'}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFeedbackChange(session, session.feedback === 'bad' ? null : 'bad');
                        }}
                      />
                    </span>
                    <span className="md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                      {session.status === 'deleted' || session.status === 'archived' ? (
                        <ModalActionBtn
                          type="restore"
                          title="Restore"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStatusChange(session, 'active');
                          }}
                        />
                      ) : (
                        <ModalActionBtn
                          type="archive"
                          title="Archive"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStatusChange(session, 'archived');
                          }}
                        />
                      )}
                      <ModalActionBtn
                        type="trash"
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(session);
                        }}
                      />
                    </span>
                  </div>
                  <div className="hidden md:block flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                    <StarRating value={session.rating || 0} onChange={(v) => handleInlineRating(session, v)} />
                  </div>
                  <div className="flex-shrink-0">{getFeedbackBadge(session)}</div>
                  <div className="flex-shrink-0">{getStatusBadge(session.status)}</div>
                </div>
                {/* Row 2 */}
                <div className="flex items-center gap-2 mt-0.5 text-[11px] text-fg-faint min-w-0">
                  <span className="flex-shrink-0">
                    {new Date(session.created_at).toLocaleDateString()}{' '}
                    {new Date(session.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="hidden md:inline font-mono flex-shrink-0">{session.id.slice(0, 8)}</span>
                  {session.profile_id && session.profile_id !== 'default' && (
                    <span className="inline-flex items-center px-1.5 py-0 text-[10px] font-medium rounded-full bg-info-subtle text-info border border-info flex-shrink-0">
                      {session.profile_id}
                    </span>
                  )}
                  {session.comment && (
                    <span className="text-fg-muted truncate min-w-0 flex items-center gap-0.5">
                      <Pencil size={9} /> {session.comment}
                    </span>
                  )}
                  {(session as any).tags?.length > 0 && (
                    <span className="flex items-center gap-1 flex-shrink-0">
                      {(session as any).tags.map((t: any) => (
                        <TagBadge key={t.id} name={t.name} color={t.color} />
                      ))}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {hasMore && !loading && (
            <div className="flex justify-center py-4">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)}>
                Load more ({filteredSessions.length - paginatedSessions.length} remaining)
              </Button>
            </div>
          )}
        </div>

        {/* Edit Dialog (nested inside modal) */}
        {editSession && (
          <Dialog open={true} onClose={() => setEditSession(null)} title="Rate & Comment" size="md">
            <div className="space-y-4">
              <div>
                <label className="text-sm text-fg-muted mb-2 block">Rating</label>
                <StarRating value={ratingValue} onChange={setRatingValue} />
              </div>
              <div>
                <label className="text-sm text-fg-muted mb-2 block">Admin Comment</label>
                <Textarea
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  rows={3}
                  placeholder="Add notes for review..."
                  className="bg-surface-sunken"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setEditSession(null)}>
                  Cancel
                </Button>
                <Button onClick={handleSaveEdit}>Save</Button>
              </div>
            </div>
          </Dialog>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!pendingDeleteSession}
        onClose={() => setPendingDeleteSession(null)}
        onConfirm={async () => {
          if (pendingDeleteSession) {
            await api.deleteSession(pendingDeleteSession.id);
            setAllSessions((prev) => prev.filter((s) => s.id !== pendingDeleteSession.id));
            toast(t('chat.sessionPermanentlyDeleted'), 'success');
            setPendingDeleteSession(null);
          }
        }}
        title={t('chat.deleteSessionTitle')}
        description={t('chat.deleteCannotUndo')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />

      <TagManagerDialog
        open={showTagManager}
        onClose={() => setShowTagManager(false)}
        onTagsChanged={() => loadSessions()}
      />
    </>
  );
}

// ─── Action Button for Modal ──

function ModalActionBtn({
  type,
  title,
  active,
  onClick,
}: {
  type: string;
  title: string;
  active?: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const iconMap: Record<string, React.ReactNode> = {
    comment: <Pencil size={12} />,
    'star-fill': <Star size={12} className="fill-current text-yellow-400" />,
    star: <Star size={12} />,
    thumbsup: <ThumbsUp size={12} />,
    thumbsdown: <ThumbsDown size={12} />,
    restore: <RotateCcw size={12} />,
    archive: <Archive size={12} />,
    trash: <Trash2 size={12} />,
  };
  return (
    <button
      onClick={onClick}
      title={title}
      className={`inline-flex items-center justify-center w-6 h-6 rounded transition-colors text-xs ${
        active
          ? 'bg-primary-subtle text-primary-fg-strong'
          : 'text-fg-faint hover:text-fg-secondary hover:bg-surface-muted'
      }`}
    >
      {iconMap[type] || type}
    </button>
  );
}
