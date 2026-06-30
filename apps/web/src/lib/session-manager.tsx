/**
 * SessionManager — Global multi-session streaming manager.
 *
 * Keeps streaming connections alive across page navigation.
 * Supports multiple concurrent sessions with status tracking (streaming/unread/important).
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { StreamingToolCall } from '../components/chat/pipeline-viewer';
import * as api from './api';
import { handleStreamEvent } from './stream-events';
import type { ClientActionDescriptor } from '@greenhouse/types/api';

// ─── Types ───────────────────────────────────────────────

export interface ManagedSession {
  sessionId: string;
  status: 'streaming' | 'completed' | 'error';
  /** True while the local turn is enqueued behind another (not yet running). */
  queued?: boolean;
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

  /** The session ID currently being viewed in ChatPage */
  currentViewingSession: string | null;
  setCurrentViewingSession: (id: string | null) => void;

  /** Start streaming a message in a session (fire-and-forget) */
  sendMessage: (
    sessionId: string,
    message: string,
    images?: Array<{ id: string; url: string }>,
    modelOverride?: string,
    contextHint?: string,
    clientActions?: ClientActionDescriptor[],
  ) => void;

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
  const [currentViewingSession, setCurrentViewingSession] = useState<string | null>(null);

  // Refs for abort controllers (not in state to avoid re-renders)
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  // Refs for RAF-based streaming updates
  const streamDataRef = useRef<Map<string, { text: string; reasoning: string; toolCalls: StreamingToolCall[] }>>(
    new Map(),
  );
  const rafRef = useRef<Map<string, number>>(new Map());

  // currentViewingSession read inside the long-lived event handler — via ref to avoid stale closures.
  const currentViewingSessionRef = useRef<string | null>(null);
  currentViewingSessionRef.current = currentViewingSession;

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

  const sendMessage = useCallback(
    (
      sessionId: string,
      message: string,
      images?: Array<{ id: string; url: string }>,
      modelOverride?: string,
      contextHint?: string,
      clientActions?: ClientActionDescriptor[],
    ) => {
      // Create abort controller
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

      // Remove from unread since user just sent a message
      setUnreadSessions((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });

      // Start streaming in background (fire-and-forget)
      (async () => {
        try {
          const stream = api.streamChat(
            sessionId,
            message,
            images,
            abortController.signal,
            modelOverride,
            contextHint,
            clientActions,
          );

          for await (const event of stream) {
            const data = streamDataRef.current.get(sessionId);
            if (!data) break;

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
                data.toolCalls = data.toolCalls.map((tc) => (tc.id === id ? { ...tc, input: tc.input + delta } : tc));
                scheduleUpdate(sessionId);
              },
              onToolCall: (_toolName, input, id) => {
                data.toolCalls = data.toolCalls.map((tc) =>
                  tc.id === id ? { ...tc, input: JSON.stringify(input) } : tc,
                );
                scheduleUpdate(sessionId);
              },
              onToolResult: (id, _toolName, output) => {
                data.toolCalls = data.toolCalls.map((tc) =>
                  tc.id === id ? { ...tc, output, status: 'done' as const } : tc,
                );
                scheduleUpdate(sessionId);
              },
              onLocalToolRequest: (toolCallId, toolId, params) => {
                void (async () => {
                  try {
                    // Web UI actions (navigate / prefill / read current view) run in the
                    // browser — the backend streams a client-action request and waits for
                    // the result we POST back.
                    const { isClientAction, executeClientAction } = await import('./client-actions/executor');
                    if (isClientAction(toolId)) {
                      const result = await executeClientAction(toolCallId, toolId, params);
                      await api.postLocalToolResult(sessionId, result);
                      return;
                    }

                    console.warn('[SessionManager] tool-request for unknown client tool:', toolId);
                    await api.postLocalToolResult(sessionId, {
                      toolCallId,
                      output: null,
                      error: `Tool "${toolId}" is not available in this client.`,
                    });
                  } catch (err) {
                    console.error('[SessionManager] client tool execution failed:', err);
                    await api.postLocalToolResult(sessionId, {
                      toolCallId,
                      output: null,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                })();
              },
              onError: (error) => {
                setActiveSessions((prev) => {
                  const next = new Map(prev);
                  const session = next.get(sessionId);
                  if (session) {
                    next.set(sessionId, { ...session, status: 'error', error });
                  }
                  return next;
                });
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

          // Mark as unread if user is NOT currently viewing this session
          setUnreadSessions((prev) => {
            // Check current viewing at the time of completion
            if (currentViewingSession !== sessionId) {
              const next = new Set(prev);
              next.add(sessionId);
              return next;
            }
            return prev;
          });
        } catch (err: any) {
          if (err.name !== 'AbortError') {
            setActiveSessions((prev) => {
              const next = new Map(prev);
              const session = next.get(sessionId);
              if (session) {
                next.set(sessionId, { ...session, status: 'error', error: err.message || 'Stream failed' });
              }
              return next;
            });
          }
        } finally {
          // Cleanup
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
    [scheduleUpdate, currentViewingSession],
  );

  const stopSession = useCallback((sessionId: string) => {
    const controller = abortControllersRef.current.get(sessionId);
    if (controller) {
      controller.abort();
    }
    // Mark as completed (with whatever text was collected)
    setActiveSessions((prev) => {
      const next = new Map(prev);
      const session = next.get(sessionId);
      if (session && session.status === 'streaming') {
        next.set(sessionId, { ...session, status: 'completed' });
      }
      return next;
    });
  }, []);

  const markRead = useCallback((sessionId: string) => {
    setUnreadSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

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
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const value: SessionManagerContextValue = {
    activeSessions,
    unreadSessions,
    importantSessions,
    currentViewingSession,
    setCurrentViewingSession,
    sendMessage,
    stopSession,
    markRead,
    markImportant,
    isSessionStreaming,
    clearSession,
  };

  return <SessionManagerContext.Provider value={value}>{children}</SessionManagerContext.Provider>;
}
