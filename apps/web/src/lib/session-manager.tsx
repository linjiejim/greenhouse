/**
 * SessionManager — Global multi-session streaming manager.
 *
 * Keeps streaming connections alive across page navigation, and re-attaches to
 * server-side runs after a refresh/disconnect: generations run in the cloud
 * (chat run registry), so a dropped transport resumes from the last seq via
 * GET /api/chat/runs/:sessionId/stream instead of losing the turn.
 * Supports multiple concurrent sessions with status tracking (streaming/unread/important).
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { StreamingToolCall } from './stream-events';
import * as api from './api';
import type { SeqStreamEvent } from './api/chat';
import { handleStreamEvent } from './stream-events';
import { collectVisibleSessionIds } from './session-visibility';
import { wsClient } from './ws';
import type { ChatTurnEnvironment } from '@greenhouse/types/api';
import { notifyWorkbenchChanged } from './workbench/sync';
import { entityDomainForTool, notifyEntityChanged } from './entity-sync';

// ─── Types ───────────────────────────────────────────────

export interface ManagedSession {
  sessionId: string;
  status: 'streaming' | 'stopping' | 'completed' | 'error';
  streamText: string;
  streamReasoning: string;
  streamToolCalls: StreamingToolCall[];
  generatedTitle?: string;
  error?: string;
  startedAt: number;
}

export interface SessionManagerContextValue {
  /** Currently streaming or recently completed sessions */
  activeSessions: Map<string, ManagedSession>;

  /** Session IDs that have new responses the user hasn't seen */
  unreadSessions: Set<string>;

  /** Session IDs marked as important by the user */
  importantSessions: Set<string>;

  /**
   * Sessions the server reports as generating (via WS chat:run + the runs
   * seed). Survives refresh — the sidebar dot and auto-attach read this.
   */
  remoteStreamingSessions: Set<string>;

  /** Sessions currently visible in one or more full/overlay/split viewports. */
  visibleSessions: Set<string>;
  registerViewport: (viewportId: string, sessionId: string | null, visible: boolean) => void;
  unregisterViewport: (viewportId: string) => void;

  /** Start streaming a message in a session (fire-and-forget) */
  sendMessage: (
    sessionId: string,
    message: string | undefined,
    images?: Array<{ id: string; url: string }>,
    environment?: ChatTurnEnvironment,
    regenerateAssistantMessageId?: string,
  ) => void;

  /** Attach to a generation already running server-side (after refresh / other tab) */
  attachSession: (sessionId: string) => void;

  /** Stop a streaming session */
  stopSession: (sessionId: string) => void;

  /** Mark a session as read (clear unread status) */
  markRead: (sessionId: string) => void;

  /** Toggle important status for a session */
  markImportant: (sessionId: string, important: boolean) => void;

  /** Check if a session is currently streaming */
  isSessionStreaming: (sessionId: string) => boolean;

  /** Clear a completed/error session from active tracking */
  clearSession: (sessionId: string) => void;
}

// ─── Context ─────────────────────────────────────────────

const SessionManagerContext = createContext<SessionManagerContextValue | null>(null);

export function useSessionManager(): SessionManagerContextValue {
  const ctx = useContext(SessionManagerContext);
  if (!ctx) throw new Error('useSessionManager must be used within SessionManagerProvider');
  return ctx;
}

/** Max transparent re-attach attempts after a transport failure mid-stream. */
const MAX_RESUME_ATTEMPTS = 5;

// ─── Provider ────────────────────────────────────────────

export function SessionManagerProvider({ children }: { children: React.ReactNode }) {
  const [activeSessions, setActiveSessions] = useState<Map<string, ManagedSession>>(new Map());
  const [unreadSessions, setUnreadSessions] = useState<Set<string>>(new Set());
  const [importantSessions, setImportantSessions] = useState<Set<string>>(() => {
    // Restore from localStorage
    try {
      const stored = localStorage.getItem('greenhouse:important-sessions');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch (_err) {
      return new Set();
    }
  });
  const [remoteStreamingSessions, setRemoteStreamingSessions] = useState<Set<string>>(new Set());
  const [visibleSessions, setVisibleSessions] = useState<Set<string>>(new Set());
  const viewportsRef = useRef<Map<string, { sessionId: string | null; visible: boolean }>>(new Map());
  const visibleSessionsRef = useRef<Set<string>>(new Set());

  // Refs for abort controllers (not in state to avoid re-renders)
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Sessions the user asked to stop — used to suppress the error banner for
  // the expected interruption that follows a server-side stop.
  const stoppingRef = useRef<Set<string>>(new Set());

  // Refs for RAF-based streaming updates
  const streamDataRef = useRef<Map<string, { text: string; reasoning: string; toolCalls: StreamingToolCall[] }>>(
    new Map(),
  );
  const rafRef = useRef<Map<string, number>>(new Map());

  // Persist important sessions to localStorage
  useEffect(() => {
    localStorage.setItem('greenhouse:important-sessions', JSON.stringify([...importantSessions]));
  }, [importantSessions]);

  const scheduleUpdate = useCallback((sessionId: string) => {
    if (rafRef.current.has(sessionId)) return;
    const rafId = requestAnimationFrame(() => {
      rafRef.current.delete(sessionId);
      const data = streamDataRef.current.get(sessionId);
      if (!data) return;
      setActiveSessions((prev) => {
        const next = new Map(prev);
        const session = next.get(sessionId);
        if (session && session.status === 'streaming') {
          next.set(sessionId, {
            ...session,
            streamText: data.text,
            streamReasoning: data.reasoning,
            streamToolCalls: [...data.toolCalls],
          });
        }
        return next;
      });
    });
    rafRef.current.set(sessionId, rafId);
  }, []);

  /**
   * Consume one turn's event stream for a session — used both for a fresh send
   * (POST /api/chat) and for attaching to a run already live server-side.
   * A transport drop mid-stream re-attaches from the last seq; the generation
   * itself keeps running in the cloud either way.
   */
  const runStream = useCallback(
    (
      sessionId: string,
      initial?: {
        message?: string;
        images?: Array<{ id: string; url: string }>;
        environment?: ChatTurnEnvironment;
        regenerateAssistantMessageId?: string;
      },
    ) => {
      // One local consumer per session — a duplicate send would 409 anyway.
      if (streamDataRef.current.has(sessionId)) return;

      const abortController = new AbortController();
      abortControllersRef.current.set(sessionId, abortController);

      // Initialize stream data ref
      streamDataRef.current.set(sessionId, { text: '', reasoning: '', toolCalls: [] });

      // Add to active sessions as streaming
      setActiveSessions((prev) => {
        const next = new Map(prev);
        next.set(sessionId, {
          sessionId,
          status: 'streaming',
          streamText: '',
          streamReasoning: '',
          streamToolCalls: [],
          startedAt: Date.now(),
        });
        return next;
      });

      if (initial) {
        // Remove from unread since user just sent a message
        setUnreadSessions((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
      }

      // Start streaming in background (fire-and-forget)
      (async () => {
        let reportedStreamError: string | undefined;
        let lastSeq = -1;
        let resumeAttempts = 0;
        try {
          let source: AsyncIterable<SeqStreamEvent> = initial
            ? (api.streamChat(
                sessionId,
                initial.message,
                initial.images,
                abortController.signal,
                initial.environment,
                initial.regenerateAssistantMessageId,
              ) as AsyncIterable<SeqStreamEvent>)
            : api.streamChatRun(sessionId, lastSeq, abortController.signal);

          let finished = false;
          let runGone = false;
          while (!finished && !runGone) {
            try {
              for await (const event of source) {
                if (typeof event.seq === 'number') lastSeq = event.seq;
                const data = streamDataRef.current.get(sessionId);
                if (!data) break;

                // A replayed client-action request belongs to the page instance
                // that advertised it — never re-execute it after a refresh (the
                // server-side bridge self-resolves via its timeout).
                if (event.type === 'local-tool-request' && event.replayed) continue;

                handleStreamEvent(event, {
                  onTextDelta: (text) => {
                    data.text += text;
                    scheduleUpdate(sessionId);
                  },
                  onReasoningDelta: (text) => {
                    data.reasoning += text;
                    scheduleUpdate(sessionId);
                  },
                  onToolCallStart: (id, toolName) => {
                    data.toolCalls = [...data.toolCalls, { id, name: toolName, input: '', status: 'calling' as const }];
                    scheduleUpdate(sessionId);
                  },
                  onToolCallDelta: (id, delta) => {
                    data.toolCalls = data.toolCalls.map((tc) =>
                      tc.id === id ? { ...tc, input: tc.input + delta } : tc,
                    );
                    scheduleUpdate(sessionId);
                  },
                  onToolCall: (_toolName, input, id) => {
                    data.toolCalls = data.toolCalls.map((tc) =>
                      tc.id === id ? { ...tc, input: JSON.stringify(input) } : tc,
                    );
                    scheduleUpdate(sessionId);
                  },
                  onToolResult: (id, toolName, output) => {
                    data.toolCalls = data.toolCalls.map((tc) =>
                      tc.id === id ? { ...tc, output, status: 'done' as const } : tc,
                    );
                    if (toolName === 'workbench_mutation') notifyWorkbenchChanged();
                    // A record open in the side pane was fetched before this
                    // turn wrote to it; without this it would keep showing the
                    // pre-edit version while the user watches.
                    const domain = entityDomainForTool(toolName);
                    if (domain) notifyEntityChanged(domain);
                    scheduleUpdate(sessionId);
                  },
                  onLocalToolRequest: (toolCallId, toolId, params, scopeId) => {
                    void (async () => {
                      try {
                        // Client Actions (navigate / prefill / read current view) run in
                        // the browser and return their result to the paused agent turn.
                        const { executeClientAction } = await import('./client-actions/executor');
                        if (scopeId) {
                          const result = await executeClientAction(toolCallId, toolId, params, scopeId);
                          await api.postClientActionResult(sessionId, result);
                          return;
                        }

                        console.warn('[SessionManager] unknown client action:', toolId);
                        await api.postClientActionResult(sessionId, {
                          toolCallId,
                          output: null,
                          error: `Unknown client action: ${toolId}`,
                        });
                      } catch (err) {
                        console.error('[SessionManager] client action execution failed:', err);
                        await api.postClientActionResult(sessionId, {
                          toolCallId,
                          output: null,
                          error: err instanceof Error ? err.message : String(err),
                        });
                      }
                    })();
                  },
                  onError: (error) => {
                    // Keep consuming until the server closes the response. The API
                    // persists partial content before EOF, so surfacing the error
                    // immediately would race the follow-up session reload.
                    reportedStreamError = error;
                  },
                  onTitle: (title) => {
                    // Store generated title in managed session for ChatPage to pick up
                    setActiveSessions((prev) => {
                      const next = new Map(prev);
                      const session = next.get(sessionId);
                      if (session) {
                        next.set(sessionId, { ...session, generatedTitle: title });
                      }
                      return next;
                    });
                  },
                });
              }
              finished = true; // explicit `finish` observed (guarded by requireChatStreamFinish)
            } catch (err: any) {
              if (err?.name === 'AbortError') throw err;
              // A server-declared error means the run failed and its safe
              // partial is persisted — surface it, don't retry.
              if (reportedStreamError) throw err;
              // Transport died (proxy idle timeout, network blip, laptop sleep).
              // The generation is still running in the cloud — re-attach from
              // the last event we saw instead of failing the turn.
              if (resumeAttempts >= MAX_RESUME_ATTEMPTS) throw err;
              resumeAttempts++;
              await new Promise((r) => setTimeout(r, Math.min(1000 * resumeAttempts, 5000)));
              try {
                const probe = await api.getChatRun(sessionId);
                if (!probe.run) {
                  // Run already evicted — whatever the server persisted is final.
                  runGone = true;
                  continue;
                }
              } catch {
                /* probe unreachable — recreate the source and let the loop retry */
              }
              source = api.streamChatRun(sessionId, lastSeq, abortController.signal);
            }
          }

          // Stream completed successfully
          const finalData = streamDataRef.current.get(sessionId);
          setActiveSessions((prev) => {
            const next = new Map(prev);
            const session = next.get(sessionId);
            if (session) {
              next.set(sessionId, {
                ...session,
                status: 'completed',
                streamText: finalData?.text ?? session.streamText,
                streamReasoning: finalData?.reasoning ?? session.streamReasoning,
                streamToolCalls: finalData?.toolCalls ?? session.streamToolCalls,
              });
            }
            return next;
          });

          // Mark as unread if user is NOT currently viewing this session.
          // Read from the ref because the user may have entered the session
          // after the stream started.
          setUnreadSessions((prev) => {
            if (!visibleSessionsRef.current.has(sessionId)) {
              const next = new Set(prev);
              next.add(sessionId);
              return next;
            }
            return prev;
          });
        } catch (err: any) {
          if (err.name !== 'AbortError') {
            const wasStopping = stoppingRef.current.has(sessionId);
            const finalData = streamDataRef.current.get(sessionId);
            setActiveSessions((prev) => {
              const next = new Map(prev);
              const session = next.get(sessionId);
              if (session) {
                next.set(sessionId, {
                  ...session,
                  status: wasStopping ? 'completed' : 'error',
                  // A user-initiated stop is an expected interruption: reconcile
                  // with the persisted partial, but skip the error banner.
                  error: wasStopping ? undefined : reportedStreamError || err.message || 'Stream failed',
                  streamText: finalData?.text ?? session.streamText,
                  streamReasoning: finalData?.reasoning ?? session.streamReasoning,
                  streamToolCalls: finalData?.toolCalls ?? session.streamToolCalls,
                });
              }
              return next;
            });
          }
        } finally {
          // Cleanup
          stoppingRef.current.delete(sessionId);
          abortControllersRef.current.delete(sessionId);
          streamDataRef.current.delete(sessionId);
          const rafId = rafRef.current.get(sessionId);
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafRef.current.delete(sessionId);
          }
        }
      })();
    },
    [scheduleUpdate],
  );

  const sendMessage = useCallback(
    (
      sessionId: string,
      message: string | undefined,
      images?: Array<{ id: string; url: string }>,
      environment?: ChatTurnEnvironment,
      regenerateAssistantMessageId?: string,
    ) => {
      runStream(sessionId, { message, images, environment, regenerateAssistantMessageId });
    },
    [runStream],
  );

  const attachSession = useCallback(
    (sessionId: string) => {
      runStream(sessionId);
    },
    [runStream],
  );

  // ── Server-side run state: seed on load/WS-reconnect, follow chat:run ──
  const seedRemoteRuns = useCallback(() => {
    api
      .listChatRuns()
      .then(({ runs }) =>
        setRemoteStreamingSessions(
          new Set(runs.map((r) => r.session_id).filter((sessionId) => !stoppingRef.current.has(sessionId))),
        ),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    seedRemoteRuns();
    const unsubEvent = wsClient.onEvent((event) => {
      if (event.type !== 'chat:run') return;
      setRemoteStreamingSessions((prev) => {
        const shouldHave = event.status === 'running' && !stoppingRef.current.has(event.sessionId);
        if (prev.has(event.sessionId) === shouldHave) return prev;
        const next = new Set(prev);
        if (shouldHave) next.add(event.sessionId);
        else next.delete(event.sessionId);
        return next;
      });
      // A turn finished for a session no viewport is showing → unread dot,
      // even when no tab was attached to the stream (e.g. after a refresh).
      if (event.status === 'completed' && !visibleSessionsRef.current.has(event.sessionId)) {
        setUnreadSessions((prev) => (prev.has(event.sessionId) ? prev : new Set(prev).add(event.sessionId)));
      }
    });
    // WS reconnect can have missed lifecycle events — re-seed from the server.
    const unsubStatus = wsClient.onStatusChange((status) => {
      if (status === 'connected') seedRemoteRuns();
    });
    return () => {
      unsubEvent();
      unsubStatus();
    };
  }, [seedRemoteRuns]);

  // Auto-attach: a visible session with a server-side run but no local stream
  // (page was refreshed, or the turn was started from another tab) re-attaches
  // and replays the in-progress answer.
  useEffect(() => {
    for (const sessionId of remoteStreamingSessions) {
      if (!visibleSessions.has(sessionId)) continue;
      if (streamDataRef.current.has(sessionId)) continue;
      if (activeSessions.has(sessionId)) continue;
      attachSession(sessionId);
    }
  }, [remoteStreamingSessions, visibleSessions, activeSessions, attachSession]);

  const stopSession = useCallback((sessionId: string) => {
    // Fallback for when there is no server-side run to stop (e.g. the POST
    // failed before the run registered): abort the local transport like before.
    const localStop = () => {
      stoppingRef.current.delete(sessionId);
      const controller = abortControllersRef.current.get(sessionId);
      if (controller) controller.abort();
      setActiveSessions((prev) => {
        const next = new Map(prev);
        const session = next.get(sessionId);
        if (session && (session.status === 'streaming' || session.status === 'stopping')) {
          next.set(sessionId, { ...session, status: 'completed' });
        }
        return next;
      });
      setRemoteStreamingSessions((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    };

    // Server-side stop: aborts the generation itself (it would otherwise keep
    // running in the cloud). The stream then winds down with the persisted
    // partial; stoppingRef suppresses the error banner for that expected end.
    stoppingRef.current.add(sessionId);
    // Reflect the accepted user action immediately. Keep the transport attached
    // so the server can finish persisting its partial response, but stop
    // advertising the run as live and disable any second send meanwhile.
    setActiveSessions((prev) => {
      const session = prev.get(sessionId);
      if (!session || session.status !== 'streaming') return prev;
      const next = new Map(prev);
      next.set(sessionId, { ...session, status: 'stopping' });
      return next;
    });
    setRemoteStreamingSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
    void api
      .stopChatRun(sessionId)
      .then((ok) => {
        if (!ok) localStop();
      })
      .catch(() => localStop());
  }, []);

  const markRead = useCallback((sessionId: string) => {
    setUnreadSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const syncVisibleSessions = useCallback(() => {
    const next = collectVisibleSessionIds(viewportsRef.current.values());
    visibleSessionsRef.current = next;
    setVisibleSessions(next);
    setUnreadSessions((prev) => {
      const unread = new Set(prev);
      for (const sessionId of next) unread.delete(sessionId);
      return unread.size === prev.size ? prev : unread;
    });
  }, []);

  const registerViewport = useCallback(
    (viewportId: string, sessionId: string | null, visible: boolean) => {
      viewportsRef.current.set(viewportId, { sessionId, visible });
      syncVisibleSessions();
    },
    [syncVisibleSessions],
  );

  const unregisterViewport = useCallback(
    (viewportId: string) => {
      viewportsRef.current.delete(viewportId);
      syncVisibleSessions();
    },
    [syncVisibleSessions],
  );

  const markImportant = useCallback((sessionId: string, important: boolean) => {
    setImportantSessions((prev) => {
      const next = new Set(prev);
      if (important) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
    // Also persist to server via feedback field
    api.updateSession(sessionId, { feedback: important ? 'starred' : null }).catch(() => {});
  }, []);

  const isSessionStreaming = useCallback(
    (sessionId: string) => {
      return activeSessions.get(sessionId)?.status === 'streaming';
    },
    [activeSessions],
  );

  const clearSession = useCallback((sessionId: string) => {
    setActiveSessions((prev) => {
      const session = prev.get(sessionId);
      // Never clear a live stream: a new turn may have replaced the entry the
      // caller was reconciling (e.g. attach raced a completion reload).
      if (!session || session.status === 'streaming' || session.status === 'stopping') return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const value: SessionManagerContextValue = {
    activeSessions,
    unreadSessions,
    importantSessions,
    remoteStreamingSessions,
    visibleSessions,
    registerViewport,
    unregisterViewport,
    sendMessage,
    attachSession,
    stopSession,
    markRead,
    markImportant,
    isSessionStreaming,
    clearSession,
  };

  return <SessionManagerContext.Provider value={value}>{children}</SessionManagerContext.Provider>;
}
