/**
 * Chat state hook — one active conversation, streamed turn accumulation.
 *
 * Sessions are created lazily on the first send (channel 'browser') and the
 * stream is consumed via the shared handleStreamEvent dispatcher from
 * @greenhouse/types, mirroring how the web app accumulates buffers.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { handleStreamEvent } from '@greenhouse/ui/lib/stream-events';
import type { StreamingToolCall } from '@greenhouse/ui/components/chat/streaming-message-bubble';
import type { ToolCall } from '@greenhouse/ui/components/tool-call';
import { streamChat, postToolResult } from '../lib/chat';
import { executeBrowserAction, type ConfirmRequest } from '../lib/browser-tools';
import { executeKnowledgeAction, type KnowledgeConfirmRequest } from '../lib/knowledge-tools';
import { KNOWLEDGE_ACTION_NAME } from '../lib/knowledge-actions';
import {
  decideAction,
  getMode,
  setMode as persistMode,
  getYoloSites,
  setYoloSite,
  hostOf,
  type AutomationMode,
} from '../lib/automation-prefs';
import { createSession, getSessionMessages, type BrowserSession } from '../lib/sessions';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | null;
  toolCalls: ToolCall[];
}

export interface StreamingState {
  text: string;
  reasoning: string;
  toolCalls: StreamingToolCall[];
}

/** A browser action awaiting the user's approval in the panel. */
export interface PendingAction extends ConfirmRequest {
  /** Host of the page (for the "don't ask again on this site" action). */
  host?: string;
  resolve: (allowed: boolean) => void;
  /** Allow, and don't ask again for this host for the rest of the conversation. */
  allowThisSession: () => void;
}

/** A knowledge write awaiting the user's approval in the panel. */
export interface PendingKnowledge extends KnowledgeConfirmRequest {
  resolve: (allowed: boolean) => void;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function useChat(profileId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [pendingKnowledge, setPendingKnowledge] = useState<PendingKnowledge | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Live resolvers for pending confirms — so stop/new-chat can decline them.
  const pendingResolveRef = useRef<((allowed: boolean) => void) | null>(null);
  const pendingKnowledgeResolveRef = useRef<((allowed: boolean) => void) | null>(null);

  // ── Automation permission policy ──
  const [mode, setModeState] = useState<AutomationMode>('ask');
  const [yoloSites, setYoloSites] = useState<Set<string>>(new Set());
  // Read inside requestConfirm (stable identity) without stale closures.
  const modeRef = useRef(mode);
  const yoloRef = useRef(yoloSites);
  modeRef.current = mode;
  yoloRef.current = yoloSites;
  // "Don't ask again this site" grants — session-scoped, never persisted.
  const sessionAllowedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void getMode().then(setModeState);
    void getYoloSites().then(setYoloSites);
  }, []);

  const setMode = useCallback((m: AutomationMode) => {
    setModeState(m);
    void persistMode(m);
  }, []);

  const toggleYolo = useCallback((host: string, on: boolean) => {
    void setYoloSite(host, on).then(setYoloSites);
  }, []);

  /**
   * Confirm gate handed to the browser-action executor. Applies the Ask/Auto/
   * YOLO policy: only renders a card when the policy says to ask; otherwise
   * resolves immediately.
   */
  const requestConfirm = useCallback((req: ConfirmRequest): Promise<boolean> => {
    const host = hostOf(req.pageUrl);
    const decision = decideAction(modeRef.current, host, req.signals, yoloRef.current, sessionAllowedRef.current);
    if (decision === 'allow') return Promise.resolve(true);

    return new Promise<boolean>((resolvePromise) => {
      const finish = (allowed: boolean) => {
        pendingResolveRef.current = null;
        setPendingAction(null);
        resolvePromise(allowed);
      };
      pendingResolveRef.current = finish;
      setPendingAction({
        ...req,
        host,
        resolve: finish,
        allowThisSession: () => {
          if (host) sessionAllowedRef.current.add(host);
          finish(true);
        },
      });
    });
  }, []);

  /** Confirm gate for knowledge writes — always asks (writes are never silent). */
  const requestKnowledgeConfirm = useCallback((req: KnowledgeConfirmRequest): Promise<boolean> => {
    return new Promise<boolean>((resolvePromise) => {
      const finish = (allowed: boolean) => {
        pendingKnowledgeResolveRef.current = null;
        setPendingKnowledge(null);
        resolvePromise(allowed);
      };
      pendingKnowledgeResolveRef.current = finish;
      setPendingKnowledge({ ...req, resolve: finish });
    });
  }, []);

  const send = useCallback(
    async (text: string, contextHint?: string) => {
      setError(null);
      setMessages((prev) => [...prev, { role: 'user', content: text, toolCalls: [] }]);

      let sid = sessionId;
      try {
        if (!sid) {
          const session = await createSession(profileId);
          sid = session.id;
          setSessionId(sid);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'session_create_failed');
        return;
      }

      const buffers: StreamingState = { text: '', reasoning: '', toolCalls: [] };
      const flush = () => setStreaming({ ...buffers, toolCalls: [...buffers.toolCalls] });
      const upsertCall = (id: string, patch: Partial<StreamingToolCall> & { name?: string }) => {
        const existing = buffers.toolCalls.find((tc) => tc.id === id);
        if (existing) Object.assign(existing, patch);
        else buffers.toolCalls.push({ id, name: patch.name ?? '', input: '', status: 'calling', ...patch });
      };

      const abort = new AbortController();
      abortRef.current = abort;
      setStreaming(buffers);

      try {
        for await (const event of streamChat({ sessionId: sid, message: text, contextHint, signal: abort.signal })) {
          handleStreamEvent(event, {
            onTextDelta: (t) => {
              buffers.text += t;
            },
            onReasoningDelta: (t) => {
              buffers.reasoning += t;
            },
            onToolCallStart: (id, toolName) => upsertCall(id, { name: toolName }),
            onToolCallDelta: (id, delta) => {
              const call = buffers.toolCalls.find((tc) => tc.id === id);
              if (call) call.input += delta;
            },
            onToolCall: (toolName, input, id) => {
              if (id) upsertCall(id, { name: toolName, input: JSON.stringify(input) });
            },
            onToolResult: (id, _toolName, output) => upsertCall(id, { output, status: 'done' }),
            onLocalToolRequest: (toolCallId, toolId, params) => {
              // Client-action round-trip: execute locally (writes gated by a
              // confirm card), then post the result to resume the agent.
              // Fire-and-forget — the stream stays paused server-side until the
              // result arrives, so the read loop must keep running.
              void (async () => {
                const result =
                  toolId === KNOWLEDGE_ACTION_NAME
                    ? await executeKnowledgeAction(params, requestKnowledgeConfirm, profileId)
                    : await executeBrowserAction(toolId, params, requestConfirm);
                await postToolResult(sid!, {
                  toolCallId,
                  output: 'output' in result ? result.output : null,
                  ...('error' in result ? { error: result.error } : {}),
                });
              })().catch((err) => {
                void postToolResult(sid!, {
                  toolCallId,
                  output: null,
                  error: err instanceof Error ? err.message : String(err),
                }).catch(() => {});
              });
            },
            onTitle: (t) => setTitle(t),
            onError: (message) => setError(message),
          });
          flush();
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          setError(err instanceof Error ? err.message : 'stream_failed');
        }
      } finally {
        abortRef.current = null;
        // Confirm cards must not outlive their turn (stopped/errored streams).
        pendingResolveRef.current?.(false);
        pendingKnowledgeResolveRef.current?.(false);
        // Materialize whatever streamed (even on abort/error) into the list.
        if (buffers.text || buffers.toolCalls.length > 0 || buffers.reasoning) {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: buffers.text,
              reasoning: buffers.reasoning || null,
              toolCalls: buffers.toolCalls.map((tc) => ({
                name: tc.name,
                input: tryParseJson(tc.input),
                output: tc.output,
                status: 'done' as const,
              })),
            },
          ]);
        }
        setStreaming(null);
      }
    },
    [sessionId, profileId, requestConfirm, requestKnowledgeConfirm],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const newConversation = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStreaming(null);
    setSessionId(null);
    setTitle(null);
    setError(null);
    // "Don't ask again this session" grants are scoped to one conversation.
    sessionAllowedRef.current = new Set();
  }, []);

  const loadSession = useCallback(async (session: BrowserSession) => {
    abortRef.current?.abort();
    setError(null);
    setStreaming(null);
    setSessionId(session.id);
    setTitle(session.title);
    const history = await getSessionMessages(session.id);
    setMessages(
      history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          reasoning: m.reasoning,
          toolCalls: m.toolCalls,
        })),
    );
  }, []);

  return {
    messages,
    streaming,
    sessionId,
    title,
    error,
    pendingAction,
    pendingKnowledge,
    mode,
    setMode,
    yoloSites,
    toggleYolo,
    send,
    stop,
    newConversation,
    loadSession,
  };
}
