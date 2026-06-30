/**
 * GlobalAgentPanel — Global Agent, the global AI assistant panel.
 *
 * Unified with ChatPage — shares SessionManager, ChatInput, MessageBubble,
 * StreamingMessageBubble, and streaming infrastructure.
 * Adds page context awareness + resizable modal overlay.
 *
 * Design decisions:
 * - Defaults to the "team" profile; user can switch to any system/custom agent
 *   via the ProfileSelector in the composer's rightSlot (+ @-mention), exactly like
 *   the Chat page. The picker is locked once a session exists (profile is fixed at
 *   creation); switch by starting a New conversation. The choice is persisted
 *   per-user (getGlobalAgentProfile) independently of the Chat page.
 * - Tools follow the selected profile — the session is created with the chosen
 *   profile id, and the backend resolves the tool subset from it.
 * - Shares the ChatInput composer + the same centered max-w-5xl message column.
 * - Session titles prefixed with "[Global Agent]" (or the profile name).
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Badge, Spinner } from '../ui';
import { OverlayPanel } from '../app/overlay-panel';
import { useAgentContext } from '../agent-context';
import { MessageBubble, StreamingMessageBubble } from '../chat/message';
import type { PipelineStep } from '../chat/pipeline-viewer';
import type { StreamingToolCall } from '../chat/pipeline-viewer';
import { getContextLabel, getEmptyStateMessage, getQuickActions, getContextHint } from './agent-helpers';
import { snapshotClientActions } from '../../lib/client-actions/registry';
import { getContextIcon as getCtxIconFn } from '../../lib/icons';
import { safeParse } from '../../lib/utils';
import { Bot, Clock, Plus, X, Zap, Brain } from '../../lib/icons';
import * as api from '../../lib/api';
import { useSessionManager } from '../../lib/session-manager';
import { useAuthStore, useProfileStore } from '../../stores';
import { ProfileSelector } from '../chat/profile-selector';
import { getGlobalAgentProfile, setGlobalAgentProfile } from '../../lib/profile-preferences';
import {
  readStoredModelChoice,
  storeModelChoice,
  getModelChoices,
  effectiveModelChoice,
  modelOverrideFor,
  modelChoiceTitle,
} from '../../lib/model-choice';
import { ChatInput } from '../chat/chat-input';
import type { PendingImage } from '../chat/chat-input';
import { MAX_IMAGES } from '../../lib/constants';
import { useT } from '../../lib/i18n';

// Default profile for Global Agent
const DEFAULT_AGENT_PROFILE = 'team';

// Stable empty arrays
const EMPTY_TOOL_CALLS: StreamingToolCall[] = [];

// ─── Panel message type (richer than old ChatMessage) ────

interface PanelMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | null;
  pipeline?: PipelineStep[];
  images?: Array<{ id: string; url: string }>;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  durationMs?: number | null;
  createdAt: string;
}

// ─── Nav Button (always visible in header) ───────────────

export function AgentNavButton() {
  const t = useT();
  const { toggle, isOpen } = useAgentContext();
  const { activeSessions } = useSessionManager();

  const activeCount = useMemo(() => {
    let count = 0;
    for (const s of activeSessions.values()) {
      if (s.status === 'streaming') count++;
    }
    return count;
  }, [activeSessions]);

  return (
    <button
      onClick={toggle}
      className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
        isOpen
          ? 'bg-primary-subtle text-primary-fg-strong font-medium shadow-sm'
          : 'text-fg-muted hover:text-fg-secondary hover:bg-surface-sunken'
      }`}
      title={t('app.agentPanel')}
    >
      <span className="text-xs">
        <Bot size={14} />
      </span>
      <span className="hidden md:inline">Agent</span>
      {activeCount > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[10px] font-bold text-white bg-primary-500 animate-pulse">
          {activeCount}
        </span>
      )}
    </button>
  );
}

// ─── Panel Modal ─────────────────────────────────────────

export function GlobalAgentPanel() {
  const {
    isOpen,
    close,
    pageContext,
    pendingPrompt,
    clearPendingPrompt,
    draftPrompt,
    clearDraftPrompt,
    pendingRestoreSessionId,
    clearPendingRestore,
    pendingProfile,
    clearPendingProfile,
  } = useAgentContext();
  const t = useT();
  const currentUser = useAuthStore((s) => s.currentUser);
  const isExternal = currentUser?.role === 'external';

  // Agent profiles (shared store with Chat page + Settings)
  const profiles = useProfileStore((s) => s.profiles);
  const fetchProfiles = useProfileStore((s) => s.fetchProfiles);

  // SessionManager
  const {
    activeSessions,
    sendMessage: smSendMessage,
    stopSession: smStopSession,
    markRead,
    setCurrentViewingSession,
    clearSession,
  } = useSessionManager();

  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  // Deferred unmount for the exit animation. `isOpen` flips instantly on every
  // close path (X, backdrop, Esc, Cmd+K, nav toggle), so we watch it here and
  // keep the panel mounted while it plays its exit, then drop it on onExited.
  const [rendered, setRendered] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (isOpen) {
      setRendered(true);
      setClosing(false);
    } else if (rendered) {
      setClosing(true);
    }
  }, [isOpen, rendered]);
  const handleExited = useCallback(() => {
    setRendered(false);
    setClosing(false);
  }, []);

  // Active profile — persisted per-user, can be overridden by openWithProfile()
  const [activeProfile, setActiveProfile] = useState(
    () => getGlobalAgentProfile(currentUser?.id) ?? DEFAULT_AGENT_PROFILE,
  );

  // User-dismissed context override
  const [contextDismissed, setContextDismissed] = useState(false);
  useEffect(() => {
    setContextDismissed(false);
  }, [pageContext?.type, pageContext?.slug, (pageContext as any)?.sessionId]);
  const effectiveContext = contextDismissed ? null : pageContext;

  // Session history
  const [showHistory, setShowHistory] = useState(false);
  const [historySessions, setHistorySessions] = useState<api.Session[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Model choice (registry id, shared with ChatPage via localStorage).
  // Only rendered/sent for profiles that declare switchable model_choices.
  const [thinkingMode, setThinkingMode] = useState<string>(() => readStoredModelChoice());
  const handleThinkingModeChange = useCallback((choiceId: string) => {
    setThinkingMode(choiceId);
    storeModelChoice(choiceId);
  }, []);
  const activeProfileMeta = profiles.find((p) => p.id === activeProfile);
  const modelChoices = getModelChoices(activeProfileMeta);
  const activeModelChoice = effectiveModelChoice(modelChoices, thinkingMode);

  // Image upload state
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  // /slash command state
  const [slashPrompts, setSlashPrompts] = useState<api.UserPrompt[]>([]);

  // Load slash prompts on mount
  useEffect(() => {
    if (!isExternal) {
      api
        .fetchPrompts()
        .then(setSlashPrompts)
        .catch(() => {});
    }
  }, [isExternal]);

  // Resizable panel dimensions (desktop only)
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(() => Math.max(480, Math.round(window.innerWidth * 0.8)));
  const [panelHeight, setPanelHeight] = useState(() => window.innerHeight - 64);
  const isDraggingResize = useRef<'left' | 'top' | 'top-left' | null>(null);
  const dragStart = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Get current session streaming state from SessionManager
  const activeSession = sessionId ? activeSessions.get(sessionId) : undefined;
  const isStreaming = activeSession?.status === 'streaming';
  const streamText = activeSession?.streamText ?? '';
  const streamReasoning = activeSession?.streamReasoning ?? '';
  const streamToolCalls = activeSession?.streamToolCalls ?? EMPTY_TOOL_CALLS;
  const streamError = activeSession?.error;

  useEffect(() => {
    if (streamError) setError(streamError);
  }, [streamError]);

  // When a managed session completes, fetch messages from server
  useEffect(() => {
    if (activeSession?.status === 'completed' && sessionId) {
      clearSession(sessionId);
      (async () => {
        try {
          const data = await api.getSession(sessionId);
          setMessages(data.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map(parseServerMessage));
        } catch (_err) {
          /* keep local state */
        }
      })();
    }
  }, [activeSession?.status, sessionId, clearSession]);

  // Resize handlers (desktop only)
  const handleResizeStart = useCallback(
    (edge: 'left' | 'top' | 'top-left') => (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingResize.current = edge;
      dragStart.current = { x: e.clientX, y: e.clientY, w: panelWidth, h: panelHeight };
      document.body.style.cursor = edge === 'left' ? 'ew-resize' : edge === 'top' ? 'ns-resize' : 'nwse-resize';
      document.body.style.userSelect = 'none';
      const handleMouseMove = (ev: MouseEvent) => {
        if (!isDraggingResize.current) return;
        const dx = dragStart.current.x - ev.clientX;
        const dy = dragStart.current.y - ev.clientY;
        if (isDraggingResize.current === 'left' || isDraggingResize.current === 'top-left')
          setPanelWidth(Math.max(400, Math.min(window.innerWidth - 32, dragStart.current.w + dx)));
        if (isDraggingResize.current === 'top' || isDraggingResize.current === 'top-left')
          setPanelHeight(Math.max(300, Math.min(window.innerHeight - 32, dragStart.current.h + dy)));
      };
      const handleMouseUp = () => {
        isDraggingResize.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [panelWidth, panelHeight],
  );

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  // Load agent profiles once the panel is opened (idempotent — shared store).
  useEffect(() => {
    if (isOpen && !isExternal) void fetchProfiles();
  }, [isOpen, isExternal, fetchProfiles]);

  // If the persisted profile no longer exists (e.g. a deleted custom agent),
  // fall back to the default so the picker + session creation stay valid.
  useEffect(() => {
    if (profiles.length === 0) return;
    if (!profiles.some((p) => p.id === activeProfile)) {
      setActiveProfile(DEFAULT_AGENT_PROFILE);
    }
  }, [profiles, activeProfile]);

  // Manual profile switch from the composer picker. Mirrors the Chat page: the
  // picker is only enabled before a session exists (a session's profile is fixed
  // at creation), so there's no conversation to reset here — just remember it.
  const handleSelectProfile = useCallback(
    (profileId: string) => {
      if (profileId === activeProfile) return;
      setActiveProfile(profileId);
      setGlobalAgentProfile(profileId, currentUser?.id);
    },
    [activeProfile, currentUser?.id],
  );

  // Handle pending profile override — reset session + switch profile
  useEffect(() => {
    if (pendingProfile && isOpen) {
      // Reset current session state
      setMessages([]);
      setSessionId(undefined);
      setError(null);
      setPendingImages([]);
      // Switch profile (and remember it as the panel's default)
      setActiveProfile(pendingProfile);
      setGlobalAgentProfile(pendingProfile, currentUser?.id);
      clearPendingProfile();
    }
  }, [pendingProfile, isOpen, clearPendingProfile, currentUser?.id]);

  // Handle pending prompt (auto-execute)
  useEffect(() => {
    if (pendingPrompt && isOpen && !isStreaming) {
      sendMessage(pendingPrompt);
      clearPendingPrompt();
    }
  }, [pendingPrompt, isOpen]);

  // Handle draft prompt (fill input, user confirms)
  useEffect(() => {
    if (draftPrompt && isOpen) {
      setInput(draftPrompt);
      clearDraftPrompt();
    }
  }, [draftPrompt, isOpen]);

  // ─── Send Message ────────────────────────────────────

  const sendMessage = useCallback(
    async (text?: string) => {
      const msg = text ?? input.trim();
      if (!msg || isStreaming) return;
      setInput('');
      setError(null);

      const uploadedImages = pendingImages.filter((img) => img.uploaded).map((img) => img.uploaded!);
      setPendingImages([]);

      const userMsg: PanelMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: msg,
        images: uploadedImages.length > 0 ? uploadedImages : undefined,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Create session if needed — always use team profile, title prefixed
      let sid = sessionId;
      if (!sid) {
        try {
          const profileLabel = activeProfile === DEFAULT_AGENT_PROFILE ? 'Global Agent' : activeProfile;
          const session = await api.createSession(`[${profileLabel}] ${msg.slice(0, 50)}`, activeProfile);
          sid = session.id;
          setSessionId(sid);
        } catch (_err) {
          setError('Failed to create session');
          return;
        }
      }

      const contextHint = getContextHint(effectiveContext);
      const modelOverride = modelOverrideFor(modelChoices, thinkingMode);
      // Advertise the current screen's UI actions only while its context is active.
      // Dismissing the context chip also revokes the agent's ability to operate the page.
      const clientActions = effectiveContext ? snapshotClientActions() : undefined;

      // Send via SessionManager — all allowed tools loaded
      smSendMessage(
        sid!,
        msg,
        uploadedImages.length > 0 ? uploadedImages : undefined,
        modelOverride,
        contextHint,
        clientActions,
      );
    },
    [
      input,
      isStreaming,
      sessionId,
      pendingImages,
      effectiveContext,
      thinkingMode,
      modelChoices,
      smSendMessage,
      activeProfile,
    ],
  );

  const handleStop = useCallback(() => {
    if (sessionId) smStopSession(sessionId);
  }, [sessionId, smStopSession]);

  // ─── Image upload handlers ───────────────────────────

  const handleImageSelect = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files).filter((f) => f.type.startsWith('image/'));
      if (fileArray.length === 0) return;
      const remaining = MAX_IMAGES - pendingImages.length;
      const toAdd = fileArray.slice(0, remaining);
      if (toAdd.length === 0) return;

      const newImages: PendingImage[] = toAdd.map((file) => ({
        file,
        preview: URL.createObjectURL(file),
        uploading: true,
      }));
      setPendingImages((prev) => [...prev, ...newImages]);

      for (const file of toAdd) {
        try {
          const result = await api.uploadImage(file);
          setPendingImages((prev) =>
            prev.map((img) =>
              img.file === file ? { ...img, uploading: false, uploaded: { id: result.id, url: result.url } } : img,
            ),
          );
        } catch (err: any) {
          setPendingImages((prev) =>
            prev.map((img) => (img.file === file ? { ...img, uploading: false, error: err.message } : img)),
          );
        }
      }
    },
    [pendingImages.length],
  );

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      const img = prev[index];
      if (img?.preview) URL.revokeObjectURL(img.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  // ─── Regenerate handler ──────────────────────────────

  const handleRegenerate = useCallback(
    async (_messageId: string) => {
      if (!sessionId || isStreaming) return;
      setError(null);
      try {
        const result = await api.regenerateResponse(sessionId);
        if (result.ok && result.lastUserMessage) {
          const data = await api.getSession(sessionId);
          setMessages(data.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map(parseServerMessage));
          await sendMessage(result.lastUserMessage);
        }
      } catch (err: any) {
        setError(err.message || 'Regenerate failed');
      }
    },
    [sessionId, isStreaming, sendMessage],
  );

  // ─── Edit handler ────────────────────────────────────

  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!sessionId || isStreaming) return;
      try {
        await api.editMessage(sessionId, messageId, newContent);
        const data = await api.getSession(sessionId);
        setMessages(data.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map(parseServerMessage));
        await sendMessage(newContent);
      } catch (err: any) {
        setError(err.message || 'Edit failed');
      }
    },
    [sessionId, isStreaming, sendMessage],
  );

  // ─── Session History ─────────────────────────────────

  const loadHistory = useCallback(async () => {
    if (historyLoading) return;
    setHistoryLoading(true);
    try {
      const sessions = await api.listSessions();
      setHistorySessions(sessions.slice(0, 20));
    } catch (err) {
      console.warn('Failed to load agent panel history:', err);
    }
    setHistoryLoading(false);
  }, [historyLoading]);

  const toggleHistory = useCallback(() => {
    if (!showHistory) loadHistory();
    setShowHistory(!showHistory);
  }, [showHistory, loadHistory]);

  const loadSession = useCallback(async (sid: string) => {
    try {
      const data = await api.getSession(sid);
      setSessionId(sid);
      setMessages(data.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map(parseServerMessage));
      setShowHistory(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Handle pending session restore
  useEffect(() => {
    if (pendingRestoreSessionId && isOpen) {
      loadSession(pendingRestoreSessionId);
      clearPendingRestore();
    }
  }, [pendingRestoreSessionId, isOpen, loadSession]);

  // Track current viewing session for unread logic
  useEffect(() => {
    if (isOpen && sessionId) {
      setCurrentViewingSession(sessionId);
      markRead(sessionId);
    }
    return () => {
      if (sessionId) setCurrentViewingSession(null);
    };
  }, [isOpen, sessionId, setCurrentViewingSession, markRead]);

  const handleNewConversation = useCallback(() => {
    setMessages([]);
    setSessionId(undefined);
    setError(null);
    setPendingImages([]);
    // Keep the currently selected agent — a new conversation continues with it.
  }, []);

  const quickActions = getQuickActions(effectiveContext);

  if (!rendered) return null;

  return (
    <OverlayPanel
      onClose={close}
      closing={closing}
      onExited={handleExited}
      panelRef={panelRef}
      className="fixed inset-0 md:inset-auto md:bottom-4 md:right-4 bg-surface-raised md:rounded-2xl shadow-2xl md:border md:border-edge z-50 flex flex-col overflow-hidden"
      style={{
        width: window.innerWidth >= 768 ? `${panelWidth}px` : undefined,
        height: window.innerWidth >= 768 ? `${panelHeight}px` : undefined,
        maxWidth: window.innerWidth >= 768 ? 'calc(100vw - 2rem)' : undefined,
        maxHeight: window.innerWidth >= 768 ? 'calc(100vh - 2rem)' : undefined,
      }}
      extraContent={
        <div className="hidden md:block">
          <div
            onMouseDown={handleResizeStart('left')}
            className="absolute left-0 top-4 bottom-4 w-1.5 cursor-ew-resize z-10 hover:bg-primary-400/50 rounded-l transition-colors"
          />
          <div
            onMouseDown={handleResizeStart('top')}
            className="absolute top-0 left-4 right-4 h-1.5 cursor-ns-resize z-10 hover:bg-primary-400/50 rounded-t transition-colors"
          />
          <div
            onMouseDown={handleResizeStart('top-left')}
            className="absolute top-0 left-0 w-4 h-4 cursor-nwse-resize z-10"
          />
        </div>
      }
    >
      {/* Header */}
      <div className="px-4 py-3 bg-surface-raised border-b border-edge flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Bot size={16} className="text-primary-fg" />
            <h3 className="text-sm font-semibold text-fg truncate">Global Agent</h3>
            {sessionId && (
              <Badge variant="secondary">
                <span className="text-[10px]">live</span>
              </Badge>
            )}
            {isStreaming && (
              <Badge variant="default">
                <span className="text-[10px]">streaming</span>
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={toggleHistory}
              className={`p-1.5 rounded-md text-xs transition-colors ${showHistory ? 'bg-primary-subtle text-primary-fg-strong' : 'text-fg-faint hover:text-fg-secondary hover:bg-surface-muted'}`}
              title="Session history"
            >
              <Clock size={14} />
            </button>
            <button
              onClick={handleNewConversation}
              className="p-1.5 rounded-md text-xs text-fg-faint hover:text-fg-secondary hover:bg-surface-muted transition-colors"
              title="New conversation"
            >
              <Plus size={14} />
            </button>
            <button
              onClick={close}
              className="p-1.5 rounded-md text-xs text-fg-faint hover:text-fg-secondary hover:bg-surface-muted transition-colors"
              title={t('common.close')}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <p className="text-[11px] text-fg-faint mt-0.5 truncate">{getContextLabel(effectiveContext)}</p>
      </div>

      {/* Session history dropdown */}
      {showHistory && (
        <div className="border-b border-edge bg-surface-raised max-h-60 overflow-y-auto">
          {historyLoading && (
            <div className="flex justify-center py-4">
              <Spinner className="h-4 w-4 text-fg-faint" />
            </div>
          )}
          {!historyLoading && historySessions.length === 0 && (
            <p className="text-xs text-fg-faint text-center py-4">No past sessions</p>
          )}
          {historySessions.map((s) => (
            <button
              key={s.id}
              onClick={() => loadSession(s.id)}
              className={`w-full text-left px-4 py-2 hover:bg-surface-sunken transition-colors border-b border-edge last:border-0 ${sessionId === s.id ? 'bg-primary-subtle' : ''}`}
            >
              <div className="text-xs text-fg-secondary truncate">{s.title || 'Untitled'}</div>
              <div className="text-[10px] text-fg-faint mt-0.5">
                {new Date(s.updated_at).toLocaleString()} · {s.id.slice(0, 8)}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Context chip */}
      {effectiveContext && (
        <div className="flex items-center gap-1.5 px-4 pt-2 pb-1 flex-shrink-0">
          <span className="text-[10px] text-fg-faint">Context:</span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-primary-subtle text-primary-fg-strong border border-primary-edge">
            <span>
              {(() => {
                const Icon = getCtxIconFn(effectiveContext.type);
                return <Icon size={12} />;
              })()}
            </span>
            <span className="truncate max-w-[200px] md:max-w-[280px]">{getContextLabel(effectiveContext)}</span>
            <button
              onClick={() => setContextDismissed(true)}
              className="ml-0.5 text-primary-400 hover:text-primary-fg-strong transition-colors"
              title="Remove context"
            >
              <X size={10} />
            </button>
          </span>
        </div>
      )}
      {contextDismissed && pageContext && (
        <div className="flex items-center gap-1.5 px-4 pt-2 pb-1 flex-shrink-0">
          <span className="text-[10px] text-fg-faint">Context removed.</span>
          <button
            onClick={() => setContextDismissed(false)}
            className="text-[10px] text-primary-fg hover:text-primary-fg-strong underline"
          >
            Restore
          </button>
        </div>
      )}

      {/* Messages — centered to the same width as the composer (max-w-5xl), matching ChatPage */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-3 md:px-4 py-4 space-y-3">
          {messages.length === 0 && !isStreaming && !showHistory && (
            <div className="text-center py-8">
              <p className="text-sm text-fg-faint mb-4">{getEmptyStateMessage(effectiveContext)}</p>
              <div className="space-y-2">
                {quickActions.map((qa, i) => (
                  <button
                    key={i}
                    onClick={() => sendMessage(qa.msg)}
                    className="w-full text-left px-3 py-2 rounded-lg border border-edge bg-surface-raised hover:border-primary-300 hover:bg-primary-subtle/30 transition-colors text-sm text-fg-secondary flex items-center gap-2"
                  >
                    <qa.icon size={14} className="text-fg-faint flex-shrink-0" />
                    <span>{qa.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => {
            const isLastUser = msg.role === 'user' && !messages.slice(idx + 1).some((m) => m.role === 'user');
            const hasFollowUp =
              msg.role === 'assistant' &&
              msg.pipeline?.some((s) => s.tool === 'ask_user' || (s.output as any)?.type === 'ask_user') &&
              idx + 1 < messages.length &&
              messages[idx + 1].role === 'user';
            return (
              <MessageBubble
                key={msg.id}
                role={msg.role}
                content={msg.content}
                messageId={msg.id}
                sessionId={sessionId}
                reasoning={msg.reasoning}
                pipeline={msg.pipeline}
                images={msg.images}
                inputTokens={msg.inputTokens}
                outputTokens={msg.outputTokens}
                cachedTokens={msg.cachedTokens}
                reasoningTokens={msg.reasoningTokens}
                durationMs={msg.durationMs}
                createdAt={msg.createdAt}
                isLastUser={isLastUser}
                isStreaming={isStreaming ?? false}
                compact
                onEdit={isLastUser && !isStreaming ? handleEditMessage : undefined}
                onRegenerate={msg.role === 'assistant' ? handleRegenerate : undefined}
                onAskUserSubmit={
                  msg.role === 'assistant' &&
                  msg.pipeline?.some((s) => s.tool === 'ask_user' || (s.output as any)?.type === 'ask_user')
                    ? (answer: string) => sendMessage(answer)
                    : undefined
                }
                onConfirmAction={msg.role === 'assistant' ? (value: string) => sendMessage(value) : undefined}
                hasFollowUpUserMessage={hasFollowUp}
              />
            );
          })}

          {/* Streaming */}
          {isStreaming && (
            <StreamingMessageBubble
              text={streamText}
              reasoning={streamReasoning}
              toolCalls={streamToolCalls}
              isStreaming={true}
            />
          )}

          {error && (
            <div className="bg-danger-subtle border border-danger rounded-lg p-3 text-xs text-danger">{error}</div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input — using shared ChatInput component.
          Drop handling lives here (not inside ChatInput) so the image is added once. */}
      <div
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) handleImageSelect(e.dataTransfer.files);
        }}
        onDragOver={(e) => e.preventDefault()}
      >
        <ChatInput
          input={input}
          setInput={setInput}
          isStreaming={isStreaming ?? false}
          pendingImages={pendingImages}
          onSend={() => sendMessage()}
          onStop={handleStop}
          onImageSelect={handleImageSelect}
          onRemoveImage={removeImage}
          maxImages={MAX_IMAGES}
          autoFocus
          slashPrompts={slashPrompts}
          profiles={profiles}
          selectedProfileId={activeProfile}
          mentionEnabled={!isExternal && !sessionId && profiles.length > 1}
          onMentionProfile={handleSelectProfile}
          rightSlot={
            !isExternal && profiles.length > 1 ? (
              <ProfileSelector
                profiles={profiles}
                selectedProfileId={activeProfile}
                onSelectProfile={handleSelectProfile}
                readonly={!!sessionId}
              />
            ) : undefined
          }
          topSlot={
            modelChoices.length > 1 ? (
              <div className="flex items-center bg-surface-muted rounded-md p-0.5">
                {modelChoices.map((choice, i) => (
                  <button
                    key={choice.id}
                    onClick={() => handleThinkingModeChange(choice.id)}
                    className={`p-1 rounded transition-colors ${activeModelChoice === choice.id ? 'bg-surface-raised text-primary-fg-strong shadow-sm' : 'text-fg-muted hover:text-fg-secondary'}`}
                    title={modelChoiceTitle(choice, t)}
                  >
                    {i === 0 ? <Zap size={13} /> : <Brain size={13} />}
                  </button>
                ))}
              </div>
            ) : undefined
          }
        />
      </div>
    </OverlayPanel>
  );
}

// ─── Helpers ─────────────────────────────────────────────

function parseServerMessage(m: api.Message): PanelMessage {
  const pipeline = safeParse<PipelineStep[]>(m.pipeline, []);
  return {
    id: m.id,
    role: m.role as 'user' | 'assistant',
    content: m.content,
    reasoning: m.reasoning || null,
    pipeline: pipeline.length > 0 ? pipeline : undefined,
    images: safeParse(m.images, undefined),
    inputTokens: m.input_tokens,
    outputTokens: m.output_tokens,
    cachedTokens: m.cached_tokens,
    reasoningTokens: m.reasoning_tokens,
    durationMs: m.duration_ms,
    createdAt: m.created_at,
  };
}
