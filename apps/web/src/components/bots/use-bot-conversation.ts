/**
 * One open Bots conversation: the persisted transcript (REST), the live
 * multi-speaker run (SessionManager — still the only stream consumer), sends
 * in flight, and the request cards' latest state.
 *
 * Freshness follows the session-modes doctrine: WS says "conversation X
 * changed", the transcript is re-read over REST; a run's own events arrive
 * through SessionManager, and when the run settles the persisted rows replace
 * the live segments in one swap.
 *
 * A room (P5) differs in three ways: every message is accepted with `202` and
 * written by the server (nobody answers unless @-mentioned), a run may be
 * someone else's (it is followed live — the page probes for one on open, since
 * the runs seed lists only the member's own — but only its asker may stop it),
 * and only the member's own messages settle their sends.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotConversationDetail, BotRequestView } from '@greenhouse/types/bots';
import * as api from '../../lib/api';
import * as botsApi from '../../lib/api/bots';
import type { BotMessage } from '../../lib/api/bots';
import { useAuthStore } from '../../stores';
import { useSessionManager, type ManagedSession } from '../../lib/session-manager';
import { wsClient } from '../../lib/ws';
import { useT } from '../../lib/i18n';
import { toast } from '../ui';
import { conversationBotIds, useBotsStore } from './bots-store';
import { seedReplyRatings } from './reply-feedback';
import { pickUpQueued, type PendingSend } from './transcript';

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

/**
 * Drop sends whose persisted copy has arrived (matched one-to-one, oldest first). In a room only
 * the member's own messages count (`me`): someone else saying the same "ok" is not this send.
 */
function settlePending(
  pending: readonly PendingWithBase[],
  messages: readonly BotMessage[],
  me: string | null = null,
): PendingWithBase[] {
  const used = new Set<string>();
  // Matching includes `sending`: the API persists the message before it answers,
  // so a reload racing the POST may already contain it.
  return pending.filter((send) => {
    const match = messages.find(
      (message) =>
        message.role === 'user' &&
        !message.bot_event &&
        (!message.author_user_id || !me || message.author_user_id === me) &&
        message.seq > send.baseSeq &&
        !used.has(message.id) &&
        message.content.trim() === send.content.trim(),
    );
    if (!match) return true;
    used.add(match.id);
    return false;
  });
}

/**
 * Where a stop stands: `soft` — the run stops once the current step is done
 * (a second press stops it at once); `hard` — stopping right now.
 */
export type StopPhase = 'soft' | 'hard' | null;

export function useBotConversation(sessionId: string) {
  const sessionManager = useSessionManager();
  const {
    registerViewport,
    unregisterViewport,
    clearSession,
    sendBotsMessage,
    rewindBotsMessage,
    stopSession,
    interruptSession,
    attachSession,
  } = sessionManager;
  const me = useAuthStore((state) => state.currentUser?.id ?? null);
  const meRef = useRef(me);
  meRef.current = me;
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
  // The conversation whose soft stop is being asked for right now (the POST in
  // flight) — the button already says "Stopping…", so a second press is the hard stop.
  const [interruptAskedFor, setInterruptAskedFor] = useState<string | null>(null);
  const messagesRef = useRef<BotMessage[]>([]);
  messagesRef.current = messages;
  const loadSeqRef = useRef(0);
  // The conversation this hook shows right now. The page is not keyed by
  // session (that would remount the computer pane on every switch), so an
  // answer that arrives after a switch must check it still belongs here.
  // (`loadSeqRef` is no substitute: every reload bumps it.)
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  // Whether the open conversation is a room (sends are accepted, never streamed; runs may be others').
  const roomRef = useRef(false);
  roomRef.current = conversation?.kind === 'room' && conversation.session_id === sessionId;
  // The Agents the member last @-mentioned in this room: a run one of them answers is theirs to stop.
  const askedRef = useRef<{ sessionId: string; botIds: ReadonlySet<string> } | null>(null);
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
      // The member's ratings of these replies, before they render (a reload shows them again).
      seedReplyRatings(page.messages, page.my_ratings);
      setConversation(page.conversation);
      setMessages(merged);
      if (page.memory_states) {
        const states = page.memory_states;
        setMemoryStates((current) => ({ ...current, ...states }));
      }
      setHasMore((previous) => (messagesRef.current.length > page.messages.length ? previous : page.has_more));
      setPending((current) => settlePending(current, merged, page.conversation.kind === 'room' ? meRef.current : null));
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

  // ── A room: someone else's run is not in the member's runs seed — probe, and follow it live ──
  const isRoom = conversation?.kind === 'room' && conversation.session_id === sessionId;
  useEffect(() => {
    if (!isRoom) return;
    let live = true;
    const probe = () => {
      api
        .getChatRun(sessionId)
        .then((run) => {
          if (live && run.active && sessionRef.current === sessionId) attachSession(sessionId);
        })
        .catch(() => {});
    };
    probe();
    const unsubscribe = wsClient.onStatusChange((status) => {
      if (status === 'connected') probe();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [attachSession, isRoom, sessionId]);

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
    // The run that answered the member's last @ in a room is over: the next one may be anyone's.
    const asked = askedRef.current;
    if (asked?.sessionId === sessionId && managed?.botSegments.some((segment) => asked.botIds.has(segment.botId))) {
      askedRef.current = null;
    }
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
      seedReplyRatings(page.messages, page.my_ratings);
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
    async (
      content: string,
      options: { images?: Array<{ id: string; url: string }>; mentions?: string[]; model?: string } = {},
    ) => {
      const clientId = `send-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const segmentsNow = streaming ? (managed?.botSegments.length ?? 0) : 0;
      const inRoom = roomRef.current;
      if (inRoom && options.mentions && options.mentions.length > 0) {
        askedRef.current = { sessionId, botIds: new Set(options.mentions) };
      }
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
              ? inRoom
                ? // A room accepts every message (202) and writes it at once, mid-run or not: it
                  // is said, where it was said — never "read after the current reply".
                  { ...send, status: 'sent' }
                : // A fresh run starts after this message; a queued one sits where it was sent.
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

  /**
   * A separate chat: edit its last member message (`content`) or answer it again. What the run
   * replaces leaves the screen at once (the server truncates the same way); a refusal puts it back
   * and rejects with the API's error, for the caller to explain.
   */
  const rewind = useCallback(
    async (messageId: string, content?: string) => {
      const before = messagesRef.current;
      const target = before.find((message) => message.id === messageId);
      if (!target) return;
      const kept = before
        .filter((message) => message.seq <= target.seq)
        .map((message) => (message.id === messageId && content !== undefined ? { ...message, content } : message));
      messagesRef.current = kept;
      setMessages(kept);
      setRunError(null);
      try {
        await rewindBotsMessage(sessionId, { messageId, ...(content !== undefined ? { content } : {}) });
      } catch (err) {
        if (sessionRef.current === sessionId) {
          messagesRef.current = before;
          setMessages(before);
        }
        throw err;
      }
    },
    [rewindBotsMessage, sessionId],
  );

  // ── A queued message the run picked up (an interjection turn answers it) ──
  // Each interjection turn of this run is matched once, as it appears.
  const segmentsNow = managed?.botSegments;
  const runKey = `${sessionId}:${managed?.startedAt ?? ''}`;
  const matchedTurns = useRef({ run: '', count: 0 });
  useEffect(() => {
    if (!segmentsNow) return;
    if (matchedTurns.current.run !== runKey) matchedTurns.current = { run: runKey, count: 0 };
    const turns = segmentsNow.flatMap((segment, index) => (segment.reason === 'interjection' ? [index] : []));
    const fresh = turns.slice(matchedTurns.current.count);
    if (fresh.length === 0) return;
    matchedTurns.current.count = turns.length;
    setPending((current) => pickUpQueued(current, fresh));
  }, [segmentsNow, runKey]);

  /**
   * Whether the member may stop the run on screen. Anywhere but a room it is theirs. In a room only
   * the asker may (the server refuses everyone else), and neither the probe nor `chat:run` says who
   * asked: a run where one of the member's own Agents speaks is theirs (only its owner can address
   * it), and so is one answered by an Agent they just @-mentioned. Unknown → no Stop.
   */
  const ownRun =
    !isRoom ||
    (managed?.botSegments ?? []).some((segment) => {
      const member = conversation?.members.find((candidate) => candidate.bot_id === segment.botId);
      if (me && member?.owner_user_id === me) return true;
      const asked = askedRef.current;
      return asked?.sessionId === sessionId && asked.botIds.has(segment.botId);
    });
  const canStop = streaming && ownRun;

  const hardStopping = managed?.status === 'stopping';
  const interrupting =
    streaming && !hardStopping && (managed?.interrupting === true || interruptAskedFor === sessionId);
  const stopPhase: StopPhase = hardStopping ? 'hard' : interrupting ? 'soft' : null;

  /**
   * Stop in two steps: the first press lets the current step finish (its tool
   * calls complete and are kept — a generated image is not thrown away), a
   * second press within the same run stops at once. A run the server cannot
   * soft-stop gets the hard stop straight away; one that had already finished
   * (`no_run`) only needs this tab to let go of it — the hard stop does that,
   * quietly.
   */
  const stop = useCallback(() => {
    if (!streaming || interrupting || hardStopping) {
      stopSession(sessionId);
      return;
    }
    setInterruptAskedFor(sessionId);
    void interruptSession(sessionId).then((outcome) => {
      setInterruptAskedFor((current) => (current === sessionId ? null : current));
      if (outcome !== 'interrupting') stopSession(sessionId);
    });
  }, [hardStopping, interruptSession, interrupting, sessionId, stopSession, streaming]);

  /**
   * "Handle now" on a message waiting in the queue: the current step finishes,
   * the turn ends, and the run reads the waiting message next. No run any more
   * (`no_run`) means it already finished — the message is read anyway, nothing
   * to say; only a refusal is worth a word.
   */
  const handleNow = useCallback(
    async (clientId: string) => {
      const mark = (nudged: boolean) =>
        setPending((current) => current.map((send) => (send.clientId === clientId ? { ...send, nudged } : send)));
      mark(true);
      if ((await interruptSession(sessionId)) !== 'refused') return;
      mark(false);
      if (sessionRef.current === sessionId) toast(t('bots.composer.handleNowFailed'), 'error');
    },
    [interruptSession, sessionId, t],
  );

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
    rewind,
    stop,
    stopPhase,
    /** A run is on screen and the member may stop it (in a room: only a run they asked for). */
    canStop,
    /** The run stops (or reads a waiting message) once the current step is done. */
    interrupting,
    handleNow,
  };
}

export type BotConversationController = ReturnType<typeof useBotConversation>;
