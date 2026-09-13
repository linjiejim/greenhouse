/**
 * FullHistoryModal — full-screen session history browser.
 *
 * This file is the shell: it loads the data, owns the filter/page state and the
 * write handlers. Rendering lives in `components/history/` (filter bar, list,
 * edit dialog) so no single file has to hold all of it at once.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ConfirmDialog, Dialog, toast } from './ui';
import * as api from '../lib/api';
import { useT } from '../lib/i18n';
import { TagManagerDialog } from './session-tags';
import type { SessionTag, SessionGroup } from '@greenhouse/types/api';
import { usePersistedPageSize } from '../hooks/use-persisted-page-size';
import {
  DEFAULT_HISTORY_FILTERS,
  countByFeedback,
  countByStatus,
  filterSessions,
  type HistoryFilters,
  type HistorySession,
} from './history/filter-model';
import { HistoryFiltersBar } from './history/history-filters';
import { HistoryList } from './history/history-list';
import { HistoryEditDialog } from './history/history-edit-dialog';

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
  const [allSessions, setAllSessions] = useState<HistorySession[]>([]);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [allTags, setAllTags] = useState<SessionTag[]>([]);
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = usePersistedPageSize('chat.history', 20);

  const [editSession, setEditSession] = useState<HistorySession | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<HistorySession | null>(null);
  const [showTagManager, setShowTagManager] = useState(false);

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

  const statusCounts = useMemo(() => countByStatus(allSessions), [allSessions]);
  const feedbackCounts = useMemo(() => countByFeedback(allSessions), [allSessions]);
  const filteredSessions = useMemo(() => filterSessions(allSessions, filters), [allSessions, filters]);

  // Any filter change resets to the first page — otherwise a narrower result set
  // leaves you parked past its end, staring at an empty list.
  const updateFilters = useCallback((patch: Partial<HistoryFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(0);
  }, []);

  const lastPage = Math.max(0, Math.ceil(filteredSessions.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const pageSessions = useMemo(
    () => filteredSessions.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
    [filteredSessions, currentPage, pageSize],
  );

  const patchSession = (id: string, patch: Partial<HistorySession>) =>
    setAllSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const handleStatusChange = async (session: HistorySession, status: string) => {
    await api.updateSession(session.id, { status });
    patchSession(session.id, { status });
  };

  const handleSaveEdit = async (session: HistorySession, values: { rating: number; comment: string }) => {
    await api.updateSession(session.id, {
      comment: values.comment || undefined,
      rating: values.rating || undefined,
    });
    patchSession(session.id, { comment: values.comment, rating: values.rating });
    setEditSession(null);
  };

  const handleDelete = async (session: HistorySession) => {
    if (session.status === 'deleted') {
      setPendingDeleteSession(session);
      return;
    }
    await api.updateSession(session.id, { status: 'deleted' });
    patchSession(session.id, { status: 'deleted' });
    toast(t('chat.sessionMovedToTrash'), 'info');
  };

  if (!open) return null;

  return (
    <>
      {/* scrollBody={false}: the list owns the only scroller, so the filter bar and
          the pagination footer stay pinned instead of scrolling away with the rows. */}
      <Dialog open={open} onClose={onClose} title={t('chat.history')} size="workspace" noPadding scrollBody={false}>
        <HistoryFiltersBar
          filters={filters}
          onChange={updateFilters}
          statusCounts={statusCounts}
          feedbackCounts={feedbackCounts}
          profiles={profiles}
          groups={groups}
          tags={allTags}
          onManageTags={() => setShowTagManager(true)}
          searchPlaceholder={t('chat.searchConversations')}
        />

        <HistoryList
          sessions={pageSessions}
          total={filteredSessions.length}
          page={currentPage}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(0);
          }}
          loading={loading}
          status={filters.status}
          onOpen={(session) => onSelectSession(session.id)}
          onEdit={setEditSession}
          onStatusChange={handleStatusChange}
          onDelete={handleDelete}
        />

        {editSession && (
          <HistoryEditDialog
            key={editSession.id}
            session={editSession}
            onClose={() => setEditSession(null)}
            onSave={handleSaveEdit}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={!!pendingDeleteSession}
        onClose={() => setPendingDeleteSession(null)}
        onConfirm={async () => {
          if (!pendingDeleteSession) return;
          await api.deleteSession(pendingDeleteSession.id);
          setAllSessions((prev) => prev.filter((s) => s.id !== pendingDeleteSession.id));
          toast(t('chat.sessionPermanentlyDeleted'), 'success');
          setPendingDeleteSession(null);
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
