/**
 * One open Bots conversation: the persisted transcript (REST), the live
 * multi-speaker run (SessionManager — still the only stream consumer), sends
 * in flight, and the request cards' latest state.
 *
 * Freshness follows the session-modes doctrine: WS says "conversation X
 * changed", the transcript is re-read over REST; a run's own events arrive
 * through SessionManager, and when the run settles the persisted rows replace
 * the live segments in one swap.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotConversationDetail, BotRequestView } from '@greenhouse/types/bots';
import * as botsApi from '../../lib/api/bots';
import type { BotMessage } from '../../lib/api/bots';
import { useSessionManager, type ManagedSession } from '../../lib/session-manager';
import { wsClient } from '../../lib/ws';
import { useT } from '../../lib/i18n';
import { toast } from '../ui';
import { conversationBotIds, useBotsStore } from './bots-store';
import type { PendingSend } from './transcript';

const VIEWPORT_ID = 'bots-page';
const PAGE_SIZE = 60;

export type ConversationLoadState = 'loading' | 'ready' | 'not_found' | 'error';

interface PendingWithBase extends PendingSend {
  /** Highest persisted seq when it was sent — the persisted copy will be newer. */
  baseSeq: number;
}

/** -1 for an empty transcript: sequence numbers start at 0. */
function maxSeq(messages: readonly BotMessage[]): number {
  return messages.reduce((max, message) => Math.max(max, message.seq), -1);
}

/** Merge a fresh latest page into what is loaded, keeping older pages the member scrolled to. */
function mergeLatest(loaded: readonly BotMessage[], latest: readonly BotMessage[]): BotMessage[] {
  if (latest.length === 0) return loaded.length ? [...loaded] : [];
  const floor = Math.min(...latest.map((message) => message.seq));
  return [...loaded.filter((message) => message.seq < floor), ...latest].sort((a, b) => a.seq - b.seq);
}

/** Drop sends whose persisted copy has arrived (matched one-to-one, oldest first). */
function settlePending(pending: readonly PendingWithBase[], messages: readonly BotMessage[]): PendingWithBase[] {
  const used = new Set<string>();
  // Matching includes `sending`: the API persists the message before it answers,
  // so a reload racing the POST may already contain it.
  return pending.filter((send) => {
    const match = messages.find(
      (message) =>
        message.role === 'user' &&
        !message.bot_event &&
        message.seq > send.baseSeq &&
        !used.has(message.id) &&
        message.content.trim() === send.content.trim(),
    );
    if (!match) return true;
    used.add(match.id);
    return false;
  });
}

export function useBotConversation(sessionId: string) {
  const sessionManager = useSessionManager();
  const { registerViewport, unregisterViewport, clearSession, sendBotsMessage, stopSession } = sessionManager;
  const managed: ManagedSession | undefined = sessionManager.activeSessions.get(sessionId);
  const streaming = managed?.status === 'streaming' || managed?.status === 'stopping';

  const [state, setState] = useState<ConversationLoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<BotConversationDetail | null>(null);
  const [messages, setMessages] = useState<BotMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [pending, setPending] = useState<PendingWithBase[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [requestOverrides, setRequestOverrides] = useState<Map<string, BotRequestView>>(new Map());
  const [memoryStates, setMemoryStates] = useState<Record<string, string>>({});
  const messagesRef = useRef<BotMessage[]>([]);
  messagesRef.current = messages;
  const loadSeqRef = useRef(0);
  // The conversation this hook shows right now. The page is not keyed by
  // session (that would remount the computer pane on every switch), so an
  // answer that arrives after a switch must check it still belongs here.
  // (`loadSeqRef` is no substitute: every reload bumps it.)
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const t = useT();

  const markRead = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    void botsApi
      .markConversationRead(sessionId)
      .then(() => {
        const store = useBotsStore.getState();
        useBotsStore.setState({
          conversations: store.conversations.map((summary) =>
            summary.session_id === sessionId && summary.attention === 'unread'
              ? { ...summary, attention: 'idle' }
              : summary,
          ),
        });
      })
      .catch(() => {});
  }, [sessionId]);

  const reload = useCallback(async () => {
    const ticket = ++loadSeqRef.current;
    try {
      const page = await botsApi.getConversation(sessionId, { limit: PAGE_SIZE });
      if (ticket !== loadSeqRef.current) return;
      // A member or speaker this tab has not seen yet (a Bot made elsewhere):
      // learn its name first instead of rendering "Deleted Bot".
      const speakers = page.messages.flatMap((message) => (message.bot_id ? [message.bot_id] : []));
      await useBotsStore
        .getState()
        .ensureBotsKnown([...conversationBotIds(page.conversation), ...speakers])
        .catch(() => {});
      if (ticket !== loadSeqRef.current) return;
      const merged = mergeLatest(messagesRef.current, page.messages);
      setConversation(page.conversation);
      setMessages(merged);
      if (page.memory_states) {
        const states = page.memory_states;
        setMemoryStates((current) => ({ ...current, ...states }));
      }
      setHasMore((previous) => (messagesRef.current.length > page.messages.length ? previous : page.has_more));
      setPending((current) => settlePending(current, merged));
      setState('ready');
      setError(null);
      useBotsStore.getState().noteSession(sessionId);
    } catch (err) {
      if (ticket !== loadSeqRef.current) return;
      const status = botsApi.isBotsApiError(err) ? err.status : 0;
      // A refresh failing after a good load keeps the transcript on screen.
      setState((current) => (current === 'ready' ? current : status === 404 ? 'not_found' : 'error'));
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  // ── Open / switch ──
  useEffect(() => {
    setState('loading');
    setConversation(null);
    setMessages([]);
    messagesRef.current = [];
    setPending([]);
    setRunError(null);
    setHasMore(false);
    // A "Load earlier" still in flight belongs to the previous conversation.
    setLoadingEarlier(false);
    setMemoryStates({});
    setRequestOverrides(new Map());
    void reload().then(markRead);
  }, [reload, markRead]);

  // ── Visible viewport → SessionManager auto-attach + unread suppression ──
  useEffect(() => {
    const sync = () => registerViewport(VIEWPORT_ID, sessionId, document.visibilityState === 'visible');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      unregisterViewport(VIEWPORT_ID);
    };
  }, [registerViewport, unregisterViewport, sessionId]);

  // ── Server-side changes (handback, task report, settled card, another tab) ──
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = wsClient.onEvent((event) => {
      if (event.type !== 'bots:conversation' || event.sessionId !== sessionId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void reload().then(markRead);
      }, 250);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [reload, markRead, sessionId]);

  // ── A run started (here, in another tab, or by the engine) → pick up what it
  // persisted before this tab attached; a run settled → swap live for persisted ──
  const startedAt = managed?.startedAt;
  useEffect(() => {
    if (startedAt) void reload();
  }, [startedAt, reload]);

  const settledStatus = managed && !streaming ? managed.status : null;
  useEffect(() => {
    if (!settledStatus) return;
    if (settledStatus === 'error') setRunError(managed?.error ?? null);
    let canceled = false;
    void reload().then(() => {
      if (canceled) return;
      clearSession(sessionId);
      markRead();
    });
    return () => {
      canceled = true;
    };
    // `managed` is read for its error only at the moment of settling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledStatus, reload, clearSession, sessionId, markRead]);

  const loadEarlier = useCallback(async () => {
    const oldest = messagesRef.current[0];
    if (!oldest || loadingEarlier) return;
    const forSession = sessionId;
    setLoadingEarlier(true);
    try {
      const page = await botsApi.getConversation(forSession, { beforeSeq: oldest.seq, limit: PAGE_SIZE });
      // Switched away meanwhile: these rows are another conversation's history.
      if (sessionRef.current !== forSession) return;
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [...page.messages.filter((message) => !known.has(message.id)), ...current].sort((a, b) => a.seq - b.seq);
      });
      setHasMore(page.has_more);
      if (page.memory_states) {
        const states = page.memory_states;
        setMemoryStates((current) => ({ ...current, ...states }));
      }
    } catch {
      if (sessionRef.current === forSession) toast(t('bots.transcript.loadEarlierFailed'), 'error');
    } finally {
      if (sessionRef.current === forSession) setLoadingEarlier(false);
    }
  }, [loadingEarlier, sessionId, t]);

  const send = useCallback(
    async (content: string, options: { images?: Array<{ id: string; url: string }>; mentions?: string[] } = {}) => {
      const clientId = `send-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const segmentsNow = streaming ? (managed?.botSegments.length ?? 0) : 0;
      setRunError(null);
      setPending((current) => [
        ...current,
        {
          clientId,
          content,
          images: options.images ?? [],
          status: 'sending',
          afterSegment: segmentsNow,
          baseSeq: maxSeq(messagesRef.current),
        },
      ]);
      try {
        const { queued } = await sendBotsMessage(sessionId, content, options);
        setPending((current) =>
          current.map((send) =>
            send.clientId === clientId
              ? // A fresh run starts after this message; a queued one sits where it was sent.
                { ...send, status: queued ? 'queued' : 'sent', afterSegment: queued ? send.afterSegment : 0 }
              : send,
          ),
        );
      } catch (err) {
        setPending((current) => current.filter((send) => send.clientId !== clientId));
        throw err;
      }
    },
    [managed?.botSegments.length, sendBotsMessage, sessionId, streaming],
  );

  const stop = useCallback(() => stopSession(sessionId), [sessionId, stopSession]);

  /**
   * Latest state of every card, from three sources (the reloaded detail, the
   * live stream, the member's own clicks). A settled state never reverts to
   * pending: the stream's copy of a card is the one it was raised with, and
   * it keeps saying "pending" until the run ends.
   */
  const requests = useMemo(() => {
    const map = new Map<string, BotRequestView>();
    const put = (request: BotRequestView) => {
      const known = map.get(request.id);
      if (known && known.status !== 'pending' && request.status === 'pending') return;
      map.set(request.id, request);
    };
    (conversation?.requests ?? []).forEach(put);
    (managed?.botRequests ?? []).forEach(put);
    requestOverrides.forEach(put);
    return map;
  }, [conversation?.requests, managed?.botRequests, requestOverrides]);

  const applyRequest = useCallback((request: BotRequestView) => {
    setRequestOverrides((current) => new Map(current).set(request.id, request));
  }, []);

  return {
    state,
    error,
    conversation,
    setConversation,
    messages,
    hasMore,
    loadingEarlier,
    loadEarlier,
    pending: pending as PendingSend[],
    managed,
    streaming,
    runError,
    dismissRunError: () => setRunError(null),
    requests,
    applyRequest,
    memoryStates,
    reload,
    send,
    stop,
  };
}

export type BotConversationController = ReturnType<typeof useBotConversation>;
