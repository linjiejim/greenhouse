import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoworkerInbox } from '@greenhouse/types/session';
import {
  fetchCoworkerInboxes,
  fetchCoworkerTopics,
  openCoworker,
  visitCoworker,
  type CoworkerHistory,
} from '../../lib/api/coworkers';
import { wsClient } from '../../lib/ws';
import { agentKey } from '../chat/agent-avatar-picker';
import { useAuthStore, useUIStore, useProfileStore } from '../../stores';
import { toast } from '../ui';
import { useT } from '../../lib/i18n';

export function coworkerLocation(profileId: string, sessionId?: string | null, messageId?: string) {
  const params = new URLSearchParams({ agent: agentKey(profileId) });
  if (sessionId) params.set('session', sessionId);
  else params.set('new', String(Date.now()));
  if (messageId) params.set('message', messageId);
  return `#/chat?${params}`;
}

export function useCoworkerInbox(
  enabled: boolean,
  profileId: string,
  sessionId: string | null,
  isOwner: boolean,
  visiting = true,
) {
  const t = useT();
  const userId = useAuthStore((s) => s.currentUser?.id);
  const version = useUIStore((s) => s.sessionListVersion);
  const [inboxes, setInboxes] = useState<CoworkerInbox[]>([]);
  const [history, setHistory] = useState<CoworkerHistory | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadedProfile, setLoadedProfile] = useState<string | null>(null);
  const generation = useRef(0);
  const navigation = useRef(0);
  useEffect(
    () => () => {
      navigation.current++;
    },
    [],
  );
  const inbox = inboxes.find((item) => agentKey(item.profile_id) === agentKey(profileId));
  const refresh = useCallback(async () => {
    if (!enabled || !userId) return;
    const request = ++generation.current;
    try {
      const { inboxes: items } = await fetchCoworkerInboxes();
      if (request !== generation.current) return;
      setInboxes(items);
      const current = items.find((item) => agentKey(item.profile_id) === agentKey(profileId));
      const next = current && isOwner ? await fetchCoworkerTopics(current.id) : null;
      if (request !== generation.current) return;
      setHistory((previous) =>
        next && previous?.inbox.id === next.inbox.id
          ? {
              ...next,
              topics: [
                ...next.topics,
                ...previous.topics.filter(
                  (topic) =>
                    previous.topics.length > 30 &&
                    topic.updated_at < (next.topics.at(-1)?.updated_at ?? '') &&
                    !next.topics.some((row) => row.id === topic.id),
                ),
              ],
              next_cursor: previous.topics.length > 30 ? previous.next_cursor : next.next_cursor,
            }
          : next,
      );
      setError(false);
      setLoadedProfile(profileId);
    } catch {
      if (request === generation.current) {
        setError(true);
        setLoadedProfile(profileId);
      }
    }
  }, [enabled, userId, profileId, isOwner]);

  useEffect(() => {
    void refresh();
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 250);
    };
    const unsubscribe = wsClient.onEvent((event) => {
      if (
        [
          'connected',
          'notification:new',
          'notification:summary',
          'session:created',
          'workflow:progress',
          'chat:run',
          'mission:run',
          'runtime:invalidate',
        ].includes(event.type)
      )
        schedule();
    });
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 10000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('coworker:read', schedule);
    return () => {
      // Invalidate outstanding requests, including refreshes issued after setup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      unsubscribe();
      clearInterval(poll);
      clearTimeout(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('coworker:read', schedule);
    };
  }, [enabled, refresh, version]);

  useEffect(() => {
    if (!enabled || !inbox || !isOwner || !visiting) return;
    // Explicit new-topic routes also come from the global sidebar action.
    // Loading an existing topic must never clear its remembered selection.
    if (!sessionId && !new URLSearchParams(window.location.hash.split('?')[1]).has('new')) return;
    void visitCoworker(inbox.id, sessionId).catch(() => {});
  }, [enabled, inbox?.id, sessionId, isOwner, visiting]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = useCallback(
    async (nextProfileId: string) => {
      if (agentKey(nextProfileId) === agentKey(profileId)) return;
      const request = ++navigation.current;
      try {
        const saved = inboxes.find((item) => agentKey(item.profile_id) === agentKey(nextProfileId));
        const available = useProfileStore
          .getState()
          .profiles.some((item) => agentKey(item.id) === agentKey(nextProfileId));
        const opened = available ? await openCoworker(nextProfileId) : null;
        const session =
          opened?.session_id ??
          (!available && saved
            ? (saved.active_session_id ?? (await fetchCoworkerTopics(saved.id)).topics[0]?.id)
            : null);
        if (request !== navigation.current) return;
        useProfileStore.getState().setPreferredProfile(nextProfileId, userId);
        window.location.hash = coworkerLocation(nextProfileId, session);
      } catch {
        toast(t('coworker.loadFailed'), 'error');
      }
    },
    [profileId, inboxes, userId, t],
  );

  const newTopic = useCallback(async () => {
    const request = ++navigation.current;
    try {
      const opened = await openCoworker(profileId);
      await visitCoworker(opened.id, null);
      if (request !== navigation.current) return;
      window.location.hash = coworkerLocation(profileId);
    } catch {
      toast(t('coworker.loadFailed'), 'error');
    }
  }, [profileId, t]);

  const loadMore = useCallback(async () => {
    if (!history?.next_cursor || loading) return;
    setLoading(true);
    const current = generation.current;
    try {
      const next = await fetchCoworkerTopics(history.inbox.id, history.next_cursor);
      if (current === generation.current)
        setHistory((prev) =>
          prev && prev.inbox.id === next.inbox.id
            ? {
                ...prev,
                next_cursor: next.next_cursor,
                topics: [
                  ...prev.topics,
                  ...next.topics.filter((topic) => !prev.topics.some((row) => row.id === topic.id)),
                ],
              }
            : prev,
        );
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [history, loading]);
  return {
    inboxes,
    inbox,
    history,
    error,
    refresh,
    navigate,
    newTopic,
    loadMore,
    loading,
    ready: loadedProfile === profileId,
  };
}
