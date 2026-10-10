/**
 * `useConversation` — the conversation engine behind the home screen: loads a
 * session's history, creates the session on the first send of a new
 * conversation, and streams agent turns.
 *
 * Streaming: NDJSON deltas (expo/fetch) append to a buffer that a ~30fps
 * "drain" reveals at a steady pace (a small share of the backlog per tick, a
 * few characters at most — Latin words whole, CJK character by character,
 * never splitting a surrogate pair; the pace is ./stream-drain.ts, shared
 * with the Bots thread) — the reply unfolds like calm typing instead of
 * slamming in whole chunks or lines, and React sees at most one commit per
 * tick. The turn is only finalized once the drain has caught up
 * with the closed stream. Tool calls (timed client-side), citations harvested
 * from tool results, reasoning, the live title, usage metrics and errors all
 * land on the assistant message.
 *
 * Runs outlive the screen. The server generates detached from the HTTP
 * response (one run per session, src/api/chat.ts), so:
 *  - leaving a conversation (drawer switch, 新对话, unmount) only *detaches*
 *    locally — the reply keeps generating;
 *  - opening a conversation probes its run and, if one is live, re-attaches
 *    (`GET /runs/:id/stream?after=-1` replays it instantly, then tails live) —
 *    also on returning to the foreground;
 *  - a transport drop mid-turn (proxy idle, backgrounding) re-attaches from
 *    the last `seq` seen (bounded retries); a stream that closes without a
 *    `finish` is treated as a drop, never as done; a run that's already gone
 *    means the persisted reply is final, so the history is reloaded;
 *  - `stop()` stops the run server-side (fire-and-forget, the local stream is
 *    dropped at once and the reply marked `stopped`), and the next send /
 *    re-run first waits for that run to wind down so it doesn't hit 409.
 *
 * Re-running the last turn (`rerun`: 重新生成 / 重试) first asks the server
 * what its tail looks like, so it never duplicates or loses a turn: a live run
 * is followed, a persisted reply to our last message is regenerated in place
 * (or simply shown, when the stream had only dropped), a persisted message
 * with no reply is continued, and a message the server never received is
 * re-sent.
 *
 * Bots (spec docs/specs/20261008-mobile-bots.md §2.5.2): `profile` starts the
 * new conversation with a given Bot (`bot:<id>` / `sprouty`) instead of the
 * saved default — that conversation only, never written to prefs. A Bots
 * conversation reached by id (`greenhouse://chat/<id>`) is not this engine's
 * to render (one turn, many speakers; a 202 that is no stream): `leave` sees
 * the loaded session first and, when it takes the session elsewhere, the load
 * stops before anything is shown or a run attached. `channel` is the loaded
 * session's channel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { handleStreamEvent, type Session, type StreamEventCallbacks } from '../shared/greenhouse-types';
import { createSession, getSession } from '../api/sessions';
import { ChatHttpError, getChatRun, stopChatRun, streamChat, streamChatRun, type RunStreamEvent } from '../api/chat';
import { t } from '../lib/i18n';
import { useTags } from '../store/tags';
import { fromStored, isErrorResult, sourceFromResult, webFromResult, type ChatMessage, type ToolStep } from './model';
import { nextReveal, TICK_MS } from './stream-drain';

let seq = 0;
export const nextId = (): string => `m${Date.now().toString(36)}-${seq++}`;

/** One stream request: a new user turn, a regeneration, or a bare continuation. */
interface TurnRequest {
  message?: string;
  images?: Array<{ id: string; url: string }>;
  regenerateId?: string;
}

/** Where a turn's events come from: a new POST, or an existing run to follow. */
type TurnSource = { kind: 'post'; req: TurnRequest } | { kind: 'attach'; after: number };

/** Re-attach attempts after a transport drop before the turn is shown as interrupted. */
const MAX_RESUMES = 3;
/** No event (not even the server's 15 s keepalive ping) for this long = a dead socket. */
const STALE_MS = 20_000;
/** Longest wait for a stopped run to wind down before the next send goes anyway. */
const WIND_DOWN_MS = 8_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A run's server start time, when it's a plausible epoch-ms (for the metrics caption). */
const runStart = (ms: number | undefined) =>
  typeof ms === 'number' && ms > Date.now() - 86_400_000 && ms <= Date.now() + 60_000 ? ms : undefined;

export function useConversation({
  initialId,
  onCreated,
  profile,
  leave,
}: {
  /** Session id from the route (absent = a new conversation). */
  initialId?: string;
  /** A new conversation's session now exists (point the route at it). */
  onCreated: (session: Session) => void;
  /** Start a new conversation with this agent (`bot:<id>`) instead of Sprouty, the main Bot. */
  profile?: string;
  /**
   * A loaded session this screen must not render (a Bots conversation): return
   * true once it has been taken elsewhere — the load stops there, still loading.
   */
  leave?: (session: Session) => boolean;
}) {
  const [sessionId, setSessionId] = useState<string | undefined>(initialId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [title, setTitle] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(!!initialId);
  const [loadFailed, setLoadFailed] = useState(false);

  const sessionRef = useRef<string | undefined>(initialId);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const streamingRef = useRef(false);
  const creatingRef = useRef(false);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  const abortRef = useRef<AbortController | null>(null);
  const textBufRef = useRef('');
  const reasonBufRef = useRef('');
  const shownRef = useRef(0); // chars of textBuf revealed so far
  const reasonShownRef = useRef(0);
  const drainRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamEndRef = useRef(false);
  /** The current turn was stopped / detached — its late events are dropped. */
  const abortedRef = useRef(false);
  /** Bumped per turn (and on detach) so a superseded pump can't touch the screen. */
  const turnRef = useRef(0);
  const startedRef = useRef(0);
  const aIdRef = useRef('');
  const lastEventAtRef = useRef(0);
  /** Set by the live pump: drop the (possibly dead) transport and re-attach. */
  const reconnectRef = useRef<(() => void) | null>(null);
  /** A stopped run still winding down server-side (the next turn waits for it). */
  const windDownRef = useRef<{ sid: string; done: Promise<void> } | null>(null);

  const patchAssistant = useCallback((fn: (m: ChatMessage) => ChatMessage) => {
    const id = aIdRef.current;
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  /* ------------------------- smooth streaming drain ------------------------- */

  const stopDrain = useCallback(() => {
    if (drainRef.current) {
      clearInterval(drainRef.current);
      drainRef.current = null;
    }
  }, []);

  const finalize = useCallback(() => {
    stopDrain();
    const seconds = (Date.now() - startedRef.current) / 1000;
    const stopped = abortedRef.current;
    patchAssistant((m) => ({
      ...m,
      text: textBufRef.current || m.text,
      reasoning: reasonBufRef.current || m.reasoning,
      // A stopped/failed turn leaves unfinished calls — never a forever-spinner.
      tools: m.tools?.map((s) => (s.status === 'running' ? { ...s, status: stopped || m.error ? 'error' : 'done' } : s)),
      metrics: m.error || stopped ? m.metrics : { ...m.metrics, seconds },
      stopped: stopped || undefined,
      status: 'done',
    }));
    streamingRef.current = false;
    setStreaming(false);
  }, [stopDrain, patchAssistant]);

  const ensureDrain = useCallback(() => {
    if (drainRef.current) return;
    drainRef.current = setInterval(() => {
      const buf = textBufRef.current;
      const backlog = buf.length - shownRef.current;
      const reasonDirty = reasonBufRef.current.length !== reasonShownRef.current;
      if (backlog <= 0 && !reasonDirty) {
        if (streamEndRef.current) finalize();
        return;
      }
      // the pace (Latin words whole, CJK char by char, faster once the wire closed) — ./stream-drain.ts
      if (backlog > 0) shownRef.current = nextReveal(buf, shownRef.current, streamEndRef.current);
      reasonShownRef.current = reasonBufRef.current.length;
      patchAssistant((m) => ({
        ...m,
        text: buf.slice(0, shownRef.current),
        reasoning: reasonBufRef.current || m.reasoning,
        // Keep the thinking face until actual text shows (reasoning alone
        // shouldn't blank the row — it only renders once done).
        status: m.status === 'thinking' && shownRef.current > 0 ? 'streaming' : m.status,
      }));
    }, TICK_MS);
  }, [finalize, patchAssistant]);

  /**
   * Leave the current turn locally (another conversation / a new one / unmount)
   * — the request is dropped but the run keeps generating server-side; coming
   * back re-attaches to it.
   */
  const detach = useCallback(() => {
    abortedRef.current = true;
    turnRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    stopDrain();
    streamingRef.current = false;
    setStreaming(false);
  }, [stopDrain]);

  // Never leave the drain running (or a request open) past unmount.
  useEffect(
    () => () => {
      stopDrain();
      abortRef.current?.abort();
    },
    [stopDrain],
  );

  const upsertTool = useCallback(
    (id: string, patch: Partial<ToolStep>) => {
      patchAssistant((m) => {
        const tools = [...(m.tools || [])];
        const idx = tools.findIndex((s) => s.id === id);
        if (idx >= 0) {
          const prev = tools[idx];
          const ms =
            patch.status && patch.status !== 'running' && prev.startedAt ? Date.now() - prev.startedAt : prev.ms;
          tools[idx] = { ...prev, ...patch, ms };
        } else {
          tools.push({ id, tool: patch.tool || 'tool', status: 'running', startedAt: Date.now(), ...patch });
        }
        return { ...m, tools, status: m.status === 'thinking' ? 'streaming' : m.status };
      });
    },
    [patchAssistant],
  );

  const harvest = useCallback(
    (tool: string, output: unknown) => {
      const source = sourceFromResult(output);
      if (source) {
        patchAssistant((m) => {
          const sources = m.sources || [];
          if (sources.some((x) => x.slug === source.slug)) return m;
          return { ...m, sources: [...sources, source] };
        });
      }
      const web = webFromResult(tool, output);
      if (web.length) patchAssistant((m) => ({ ...m, web: [...(m.web || []), ...web] }));
    },
    [patchAssistant],
  );

  /** Put a thinking placeholder on screen and reset the drain for a new turn. */
  const beginTurn = useCallback(
    (startedAt?: number) => {
      const aId = nextId();
      aIdRef.current = aId;
      turnRef.current += 1;
      stopDrain();
      textBufRef.current = '';
      reasonBufRef.current = '';
      shownRef.current = 0;
      reasonShownRef.current = 0;
      streamEndRef.current = false;
      abortedRef.current = false;
      startedRef.current = startedAt ?? Date.now();
      streamingRef.current = true;
      setStreaming(true);
      setMessages((ms) => [...ms, { id: aId, role: 'assistant', text: '', tools: [], status: 'thinking', fresh: true }]);
      return turnRef.current;
    },
    [stopDrain],
  );

  /** End the live turn without the drain (its result is being reloaded instead). */
  const settle = useCallback(() => {
    stopDrain();
    streamingRef.current = false;
    setStreaming(false);
  }, [stopDrain]);

  // `load` and `pump` call each other (a gone run reloads; a live one is
  // attached on load) — break the cycle through a ref.
  const loadRef = useRef<(id: string, opts?: { quiet?: boolean }) => Promise<void>>(async () => {});

  const pump = useCallback(
    async (src: TurnSource) => {
      const sid = sessionRef.current;
      if (!sid) return;
      const turn = turnRef.current;
      const live = () => turnRef.current === turn && !abortedRef.current && sessionRef.current === sid;
      let ac = new AbortController();
      abortRef.current = ac;
      let lastSeq = src.kind === 'attach' ? src.after : -1;
      let gotEvent = false;
      let finished = false;
      let serverError = false;
      let forced = false;
      let replaying = false;
      let attempts = 0;
      lastEventAtRef.current = Date.now();
      reconnectRef.current = () => {
        forced = true;
        ac.abort();
      };

      const cbs: StreamEventCallbacks = {
        onTextDelta: (d) => {
          textBufRef.current += d;
          // Replayed history of a re-attached run appears at once, not typed out.
          if (replaying) shownRef.current = textBufRef.current.length;
          ensureDrain();
        },
        onReasoningDelta: (d) => {
          reasonBufRef.current += d;
          ensureDrain();
        },
        onToolCallStart: (tid, name) => upsertTool(tid, { tool: name, status: 'running' }),
        onToolCall: (name, input, tid) => upsertTool(tid || name, { tool: name, input }),
        onToolResult: (tid, name, output) => {
          upsertTool(tid, { tool: name, output, status: isErrorResult(output) ? 'error' : 'done' });
          harvest(name, output);
        },
        onTitle: (next) => setTitle(next),
        onFinish: (_reason, usage) => {
          if (usage) {
            patchAssistant((m) => ({
              ...m,
              metrics: { ...m.metrics, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens },
            }));
          }
        },
        onError: (e) => patchAssistant((m) => ({ ...m, error: e })),
      };

      let source: AsyncIterable<RunStreamEvent> =
        src.kind === 'post'
          ? streamChat({
              sessionId: sid,
              message: src.req.message,
              images: src.req.images,
              regenerateAssistantMessageId: src.req.regenerateId,
              signal: ac.signal,
            })
          : streamChatRun(sid, lastSeq, ac.signal);

      let outcome: 'done' | 'detached' | 'gone' = 'done';
      const fail = (error: string, interrupted?: boolean) =>
        patchAssistant((m) => ({ ...m, error, interrupted: interrupted || undefined }));

      try {
        for (;;) {
          try {
            for await (const evt of source) {
              if (!live()) break;
              gotEvent = true;
              lastEventAtRef.current = Date.now();
              if (typeof evt.seq === 'number') lastSeq = evt.seq;
              replaying = evt.replayed === true;
              if (evt.type === 'finish') finished = true;
              if (evt.type === 'error') serverError = true;
              handleStreamEvent(evt, cbs);
            }
            if (!live()) {
              outcome = 'detached';
              break;
            }
            // A server-declared error ends the turn (its safe partial is persisted).
            if (finished || serverError) break;
            throw new Error('stream closed before finish');
          } catch (e) {
            if (!live() || (ac.signal.aborted && !forced)) {
              outcome = 'detached';
              break;
            }
            if (e instanceof ChatHttpError) {
              // Re-attaching found no run (404): it already ended — the persisted reply is final.
              if (e.status === 404 && (src.kind === 'attach' || gotEvent)) outcome = 'gone';
              else fail(e.message);
              break;
            }
            // Never reached the server (offline, DNS…) — nothing to re-attach to.
            if (!gotEvent && src.kind === 'post' && !forced) {
              fail(e instanceof Error && e.message ? e.message : t('common.error'));
              break;
            }
            // The transport dropped mid-turn; the run itself is still going in the
            // cloud — re-attach from the last event seen instead of failing.
            if (attempts >= MAX_RESUMES) {
              fail(t('chat.interrupted'), true);
              break;
            }
            attempts += 1;
            forced = false;
            await sleep(Math.min(800 * attempts, 3000));
            if (!live()) {
              outcome = 'detached';
              break;
            }
            const probe = await getChatRun(sid);
            if (!live()) {
              outcome = 'detached';
              break;
            }
            if (probe && !probe.run) {
              outcome = 'gone';
              break;
            }
            ac = new AbortController();
            abortRef.current = ac;
            source = streamChatRun(sid, lastSeq, ac.signal);
          }
        }
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        reconnectRef.current = null;
      }

      if (outcome === 'detached') {
        ac.abort();
        return;
      }
      if (outcome === 'gone') {
        settle();
        await loadRef.current(sid, { quiet: true });
        return;
      }
      // Wire is closed — let the drain reveal what's left, then finalize.
      streamEndRef.current = true;
      ensureDrain();
    },
    [ensureDrain, upsertTool, harvest, patchAssistant, settle],
  );

  /* ------------------------------ history ------------------------------ */

  /**
   * Load a session's history (and its run state). A live run is re-attached:
   * its not-yet-persisted reply is replayed from the run buffer (a stale tail
   * reply — being regenerated, or just persisted — is dropped first so it
   * never shows twice). `quiet` keeps what's on screen until the data lands.
   */
  const load = useCallback(
    async (id: string, opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) {
        setLoading(true);
        setLoadFailed(false);
      }
      const [data, probe] = await Promise.all([getSession(id), getChatRun(id)]);
      if (sessionRef.current !== id) return; // navigated elsewhere meanwhile
      if (!data) {
        setLoading(false);
        if (!opts?.quiet) setLoadFailed(true);
        return;
      }
      setChannel(data.session?.channel ?? null);
      setProfileId(data.session?.profile_id ?? null);
      // Not ours to render (a Bots conversation): stop before showing or attaching anything.
      if (data.session && leaveRef.current?.(data.session)) return;
      setTitle(data.session?.title ?? null);
      setIsOwner(data.session?.is_owner !== false);
      useTags.getState().setSessionTags(id, data.session?.tags ?? []);
      // A turn started while this was in flight (sent before history arrived):
      // keep it, history goes above it, and it's the run — never attach.
      const busy = streamingRef.current;
      let rows = (data.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
      const attach = !!probe?.active && !busy;
      if (attach && rows[rows.length - 1]?.role === 'assistant') rows = rows.slice(0, -1);
      const history = rows.map(fromStored);
      setMessages((ms) => (busy ? [...history, ...ms.filter((m) => m.fresh)] : history));
      setLoading(false);
      setLoadFailed(false);
      if (attach) {
        beginTurn(runStart(probe?.run?.started_at));
        void pump({ kind: 'attach', after: -1 });
      }
    },
    [beginTurn, pump],
  );
  loadRef.current = load;

  useEffect(() => {
    if (initialId === sessionRef.current) {
      // First mount with an id, or the route catching up with a session we
      // just created (no reload — the live turn is already on screen).
      if (initialId && messagesRef.current.length === 0 && !streamingRef.current) void load(initialId);
      return;
    }
    // Another conversation — or none (the widget's 新对话 deep link lands on
    // an already-open conversation): leave the current one; its run goes on.
    detach();
    sessionRef.current = initialId;
    setSessionId(initialId);
    setMessages([]);
    setTitle(null);
    setIsOwner(null);
    setChannel(null);
    setProfileId(null);
    setLoadFailed(false);
    if (initialId) void load(initialId);
    else setLoading(false);
  }, [initialId, load, detach]);

  // Back in the foreground: a quiet stream may be a dead socket (re-attach),
  // and a run started elsewhere / left behind may be live (follow it).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const sid = sessionRef.current;
      if (!sid || creatingRef.current) return;
      if (streamingRef.current) {
        if (Date.now() - lastEventAtRef.current > STALE_MS) reconnectRef.current?.();
        return;
      }
      void getChatRun(sid).then((p) => {
        if (p?.active && sessionRef.current === sid && !streamingRef.current) void load(sid, { quiet: true });
      });
    });
    return () => sub.remove();
  }, [load]);

  /* ------------------------------ actions ------------------------------ */

  /** Wait (bounded) for a stopped run of this session to finish winding down. */
  const awaitWindDown = useCallback(async (sid: string) => {
    const w = windDownRef.current;
    if (w && w.sid === sid) await w.done;
  }, []);

  /**
   * Send a user turn. Creates the session first for a new conversation.
   * Resolves false (and removes the optimistic bubble) if the session could
   * not be created, so the caller can restore the draft.
   */
  const send = useCallback(
    async (input: { text: string; annotation: string | null; images: Array<{ id: string; url: string }> }) => {
      if (streamingRef.current) return false;
      const wire = input.annotation ? `${input.annotation}\n\n${input.text}` : input.text;
      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        text: input.text,
        wire,
        annotation: input.annotation,
        images: input.images.length ? input.images : undefined,
        status: 'done',
        fresh: true,
      };
      setMessages((ms) => [...ms, userMsg]);

      if (!sessionRef.current) {
        creatingRef.current = true; // block a double tap (and stop) while creating
        streamingRef.current = true;
        setStreaming(true);
        const s = await createSession(profileRef.current || 'sprouty');
        creatingRef.current = false;
        if (!s) {
          streamingRef.current = false;
          setStreaming(false);
          setMessages((ms) => ms.filter((m) => m.id !== userMsg.id));
          return false;
        }
        sessionRef.current = s.id;
        setSessionId(s.id);
        setIsOwner(true);
        useTags.getState().setSessionTags(s.id, []);
        onCreatedRef.current(s);
      }
      const sid = sessionRef.current;
      const turn = beginTurn();
      await awaitWindDown(sid);
      if (turnRef.current !== turn || abortedRef.current) return true; // stopped / left meanwhile
      void pump({ kind: 'post', req: { message: wire, images: input.images.length ? input.images : undefined } });
      return true;
    },
    [beginTurn, pump, awaitWindDown],
  );

  const stop = useCallback(() => {
    if (!streamingRef.current || creatingRef.current) return;
    const sid = sessionRef.current;
    abortedRef.current = true;
    abortRef.current?.abort();
    // Reveal whatever already arrived instantly — the user asked to stop.
    shownRef.current = textBufRef.current.length;
    reasonShownRef.current = reasonBufRef.current.length;
    finalize();
    if (!sid) return;
    // Stop the generation itself, then let it persist its partial; the next
    // turn waits for this (bounded) so it doesn't collide with the old run.
    const done = (async () => {
      if (!(await stopChatRun(sid))) return;
      const until = Date.now() + WIND_DOWN_MS;
      while (Date.now() < until) {
        await sleep(300);
        const p = await getChatRun(sid);
        if (!p?.active) return;
      }
    })();
    const entry = { sid, done };
    windDownRef.current = entry;
    void done.finally(() => {
      if (windDownRef.current === entry) windDownRef.current = null;
    });
  }, [finalize]);

  /** 重新生成 / 重试 the last turn without duplicating it (see file header). */
  const rerun = useCallback(async () => {
    const sid = sessionRef.current;
    if (!sid || streamingRef.current) return;
    const local = messagesRef.current;
    const lastUserIdx = local.map((m) => m.role).lastIndexOf('user');
    if (lastUserIdx < 0) return;
    const lastUser = local[lastUserIdx];
    const tailAi = local[local.length - 1];
    const dropped = tailAi?.role === 'assistant' && !!tailAi.interrupted;
    // Drop the reply being replaced (or the failed placeholder).
    setMessages((ms) => ms.slice(0, lastUserIdx + 1));
    const turn = beginTurn();
    await awaitWindDown(sid);
    const [data, probe] = await Promise.all([getSession(sid), getChatRun(sid)]);
    if (turnRef.current !== turn || abortedRef.current) return; // stopped / left meanwhile
    if (!data) {
      patchAssistant((m) => ({ ...m, error: t('chat.loadFailed') }));
      streamEndRef.current = true;
      ensureDrain();
      return;
    }
    if (probe?.active) {
      // A generation for this turn is still running — follow it.
      settle();
      setMessages((ms) => ms.filter((m) => m.id !== aIdRef.current));
      await load(sid, { quiet: true });
      return;
    }
    const rows = (data.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
    const tail = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const wire = lastUser.wire ?? lastUser.text;
    if (tail?.role === 'assistant' && prev?.role === 'user' && prev.content === wire) {
      if (dropped) {
        // Only the connection dropped — the reply finished server-side; show it.
        settle();
        await load(sid, { quiet: true });
        return;
      }
      void pump({ kind: 'post', req: { regenerateId: tail.id } });
    } else if (tail?.role === 'user' && tail.content === wire) {
      void pump({ kind: 'post', req: {} });
    } else {
      const images = (lastUser.images ?? []).filter((im): im is { id: string; url: string } => !!im.url);
      void pump({ kind: 'post', req: { message: wire, images: images.length ? images : undefined } });
    }
  }, [beginTurn, pump, awaitWindDown, patchAssistant, ensureDrain, settle, load]);

  const reload = useCallback(() => (sessionRef.current ? load(sessionRef.current) : Promise.resolve()), [load]);

  return useMemo(
    () => ({
      sessionId,
      messages,
      title,
      setTitle,
      /** null until known (new conversations are owned). */
      isOwner,
      /** The loaded session's channel (`web`, `bots`…); null for a new one or until loaded. */
      channel,
      /** The loaded session's agent (`sprouty`, `bot:<id>`…); null for a new one or until loaded. */
      profileId,
      streaming,
      loading,
      loadFailed,
      reload,
      send,
      stop,
      rerun,
    }),
    [sessionId, messages, title, isOwner, channel, profileId, streaming, loading, loadFailed, reload, send, stop, rerun],
  );
}
