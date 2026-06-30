/**
 * Chat page — streaming conversation interface.
 * Uses SessionManager for streaming state (persists across page navigation).
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

import { MessageBubble, StreamingMessageBubble } from '../components/chat/message';
import { MessageFeedback } from '../components/chat/message-feedback';

import { ChatInput } from '../components/chat/chat-input';
import type { PendingImage } from '../components/chat/chat-input';
import { ProfileSelector, profileToSprouty } from '../components/chat/profile-selector';
import { SproutyAvatar } from '../components/sprouty/index.js';
import { useAgentContext } from '../components/agent-context';
import { useSessionManager } from '../lib/session-manager';
import { useUIStore, useAuthStore, useProfileStore } from '../stores';
import { getLastProfile, setLastProfile as saveLastProfile } from '../lib/profile-preferences';
import type { StreamingToolCall } from '../components/chat/pipeline-viewer';
import type { PipelineStep } from '../components/chat/pipeline-viewer';

// ─── Per-session draft cache (in-memory, survives session switches) ─────────
interface SessionDraft {
  input: string;
  annotations: Array<{ id: string; quote: string; note: string }>;
  thinkingMode: string;
}
const sessionDrafts = new Map<string, SessionDraft>();
const DRAFT_KEY_NEW = '__new_session__';
/** Stable empty tool-call array so the streaming overlay deps don't change every render. */
const EMPTY_TOOL_CALLS: StreamingToolCall[] = [];
import { safeParse } from '../lib/utils';
import { Zap, Brain, Share2, Eye, X, ChevronDown, SlidersHorizontal, resolveCapabilityIcon } from '../lib/icons';
import * as api from '../lib/api';
import { ShareDialog } from '../components/chat/share-dialog';
import { SessionContextDialog } from '../components/chat/session-context-dialog';
import { ProfileEditorDrawer } from '../components/chat/profile-editor';
import { Skeleton, toast } from '../components/ui';
import { handleStreamEvent } from '../lib/stream-events';
import { MAX_IMAGES } from '../lib/constants';
import { useT } from '../lib/i18n';
import {
  readStoredModelChoice,
  storeModelChoice,
  getModelChoices,
  effectiveModelChoice,
  modelOverrideFor,
  modelChoiceTitle,
} from '../lib/model-choice';

function normalizeSelectedProfileId(profileId?: string | null): string {
  return profileId || 'default';
}

interface ParsedMessage {
  /** Stable React key — survives id changes when an optimistic message is reconciled with the server row */
  clientKey: string;
  id: string;
  role: string;
  content: string;
  reasoning: string | null;
  pipeline: PipelineStep[];
  references: Array<{
    slug: string;
    title: string;
    type: string;
    category?: string;
    page_type?: string;
    relevance?: number;
  }>;
  images: Array<{ id: string; url: string }>;
  confidence: number | null;
  grounded: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
}

function ChatHistorySkeleton({ label }: { label: string }) {
  return (
    <div className="animate-fade-in space-y-2" aria-busy="true" aria-live="polite">
      <div className="max-w-[90%] min-w-0">
        <div className="rounded-xl border border-edge bg-surface-raised px-4 py-3 shadow-sm space-y-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-7 w-7 rounded-full" />
            <span className="text-xs text-fg-faint">{label}</span>
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-10/12" />
            <Skeleton className="h-4 w-7/12" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatPage({ initialSessionId, userRole }: { initialSessionId?: string; userRole?: string }) {
  const t = useT();
  const isExternal = userRole === 'external';
  const currentUser = useAuthStore((s) => s.currentUser);
  const [sessionId, setSessionId] = useState<string | null>(isExternal ? null : initialSessionId || null);
  // Web is cloud-only — there is no local (desktop) session.
  const localSessionId: string | null = null;
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [isLoadingSession, setIsLoadingSession] = useState(() => !isExternal && !!initialSessionId);
  const [input, setInput] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [sessionProfileId, setSessionProfileId] = useState('default');
  const [sessionRating, setSessionRating] = useState<number | null>(null);
  const [sessionComment, setSessionComment] = useState<string | null>(null);
  const [sessionTags, setSessionTags] = useState<Array<{ id: number; name: string; color: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  // /slash command state
  const [slashPrompts, setSlashPrompts] = useState<api.UserPrompt[]>([]);

  // Model choice (registry id, e.g. 'flash'/'pro') for profiles that declare
  // switchable model_choices. Persisted in localStorage; legacy 'fast'/'slow'
  // values from the old thinking-mode toggle are migrated on read.
  const [thinkingMode, setThinkingMode] = useState<string>(() => readStoredModelChoice());

  const handleThinkingModeChange = useCallback((choiceId: string) => {
    setThinkingMode(choiceId);
    storeModelChoice(choiceId);
  }, []);

  // Selected profile.
  const [selectedProfileId, setSelectedProfileId] = useState(() => {
    const cached = getLastProfile(currentUser?.id);
    return normalizeSelectedProfileId(cached);
  });

  // Composer @-mention: the profile explicitly mentioned for this draft (shows a
  // pill). Distinct from selectedProfileId so the pill only appears on an active
  // @-mention, not for every default/toolbar selection. We remember the prior
  // profile so removing the pill reverts to it.
  const [mentionedProfileId, setMentionedProfileId] = useState<string | null>(null);
  const profileBeforeMentionRef = useRef<string | null>(null);

  // ─── Auto-scroll: only when user is at bottom ───────────
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserAtBottomRef = useRef(true);
  const prevSessionIdRef = useRef<string | null>(sessionId || localSessionId);

  // Flag: skip session load when we just created it (first message scenario)
  const skipNextSessionLoadRef = useRef(false);
  const sessionLoadRequestRef = useRef(0);

  // Annotations for selection follow-up
  const [annotations, setAnnotations] = useState<Array<{ id: string; quote: string; note: string }>>([]);

  // Share dialog state
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // Session context (admin/test) dialog state
  const [contextDialogOpen, setContextDialogOpen] = useState(false);
  const [hasSessionContext, setHasSessionContext] = useState(false);
  // Draft context staged before the session exists; sent with session creation.
  const [draftContext, setDraftContext] = useState<import('../lib/api').SessionContextData | null>(null);
  // Share context — is the current user the session owner?
  const [isOwner, setIsOwner] = useState(true);
  const [shareCount, setShareCount] = useState(0); // -1 = team-wide
  const [shareInfo, setShareInfo] = useState<import('../lib/api').ShareInfo | null>(null);
  const [shareBannerDismissed, setShareBannerDismissed] = useState(false);

  // ─── Per-session draft: save/restore on session switch ─────────
  const draftKey = useMemo(() => sessionId || localSessionId || DRAFT_KEY_NEW, [sessionId, localSessionId]);

  // Save current draft when session changes
  useEffect(() => {
    const prevKey = prevSessionIdRef.current || DRAFT_KEY_NEW;
    if (prevKey !== draftKey) {
      // Save previous session's draft
      sessionDrafts.set(prevKey, {
        input,
        annotations,
        thinkingMode,
      });
      // Restore new session's draft (or defaults)
      const draft = sessionDrafts.get(draftKey);
      if (draft) {
        setInput(draft.input);
        setAnnotations(draft.annotations);
        setThinkingMode(draft.thinkingMode);
      } else {
        setInput('');
        setAnnotations([]);
        // Keep current thinking mode as default for new sessions
      }
      // Composer @-mention is per-draft — reset on switch.
      setMentionedProfileId(null);
      profileBeforeMentionRef.current = null;
    }
    prevSessionIdRef.current = sessionId || localSessionId;
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Image upload state
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  // Drag-drop overlay state
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  // Global agent context
  const { enrichPageContext, pageContext } = useAgentContext();

  // Session Manager (global streaming state)
  const { activeSessions, markRead, clearSession, setCurrentViewingSession, sendMessage, stopSession } =
    useSessionManager();

  // Background session state — used only for sessions that started streaming
  // before the user navigated here (SessionManager handles those).
  const activeSession = sessionId ? activeSessions.get(sessionId) : undefined;

  // Legacy: local streaming state for external/stateless mode
  const [localIsStreaming, setLocalIsStreaming] = useState(false);
  const [localStreamText, setLocalStreamText] = useState('');
  const [localStreamReasoning, setLocalStreamReasoning] = useState('');
  const [localStreamToolCalls, setLocalStreamToolCalls] = useState<StreamingToolCall[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const textRef = useRef('');
  const reasoningRef = useRef('');
  const toolCallsRef = useRef<StreamingToolCall[]>([]);
  const rafRef = useRef<number>();

  // Cloud/Team turns (keyed by sessionId) run on the SessionManager, which lives
  // above the router. Reading the live stream from the managed session — rather
  // than local component state — is what lets an in-progress answer survive
  // navigating to another session and back (ChatPage is keyed per session, so it
  // remounts on switch). Only the external/stateless path still streams into
  // local component state.
  const managed = activeSession;
  const usingManager = !isExternal && !!activeSession;

  const effectiveIsStreaming = usingManager ? managed?.status === 'streaming' : localIsStreaming;
  const effectiveStreamText = usingManager ? (managed?.streamText ?? '') : localStreamText;
  const effectiveStreamReasoning = usingManager ? (managed?.streamReasoning ?? '') : localStreamReasoning;
  const effectiveStreamToolCalls = usingManager ? (managed?.streamToolCalls ?? EMPTY_TOOL_CALLS) : localStreamToolCalls;
  // Keep the overlay up through `completed` so the final text doesn't blink out
  // before the persisted message is reloaded (setMessages + clearSession land in
  // the same React batch — no blank gap, no flash).
  const showStreamOverlay = usingManager
    ? !!managed && (managed.status === 'streaming' || managed.status === 'completed')
    : localIsStreaming;

  // Profile state — from global store (shared with settings page)
  const { profiles, fetchProfiles: loadProfiles } = useProfileStore();
  const displayProfiles = useMemo(() => profiles, [profiles]);

  // Tool list for profile editor (fork)
  const { availableTools, fetchTools: loadTools } = useProfileStore();

  // Update profile selection (don't override user's thinking mode preference)
  const handleProfileChange = useCallback(
    (profileId: string) => {
      setSelectedProfileId(profileId);
      saveLastProfile(profileId, currentUser?.id);
      // A manual toolbar change supersedes any @-mention pill.
      setMentionedProfileId(null);
      profileBeforeMentionRef.current = null;
    },
    [currentUser?.id],
  );

  // ── Composer @-mention / activations ──────────────────────────────
  // @-mention a profile: switch the active profile and surface it as a pill.
  // Don't persist it as the user's "last profile" — it's a per-draft choice.
  const handleMentionProfile = useCallback(
    (profileId: string) => {
      setMentionedProfileId((prev) => {
        if (prev === null) profileBeforeMentionRef.current = selectedProfileId;
        return profileId;
      });
      setSelectedProfileId(profileId);
    },
    [selectedProfileId],
  );

  // Remove the profile pill → revert to the profile active before the mention.
  const handleRemoveProfileChip = useCallback(() => {
    const prev = profileBeforeMentionRef.current ?? normalizeSelectedProfileId(getLastProfile(currentUser?.id));
    setSelectedProfileId(prev);
    setMentionedProfileId(null);
    profileBeforeMentionRef.current = null;
  }, [currentUser?.id]);

  // Fork profile state
  const [forkDrawerOpen, setForkDrawerOpen] = useState(false);
  const [forkedProfile, setForkedProfile] = useState<api.Profile | null>(null);

  const handleFork = useCallback(async (profileId: string) => {
    try {
      const forked = await api.forkProfile(profileId);
      setForkedProfile(forked);
      setForkDrawerOpen(true);
    } catch (err: any) {
      toast(err.message || 'Failed to fork profile', 'error');
    }
  }, []);

  const handleForkSave = useCallback(
    async (input: api.CustomProfileInput, editId?: number) => {
      if (editId !== undefined) {
        await api.updateCustomProfile(editId, input);
      }
      setForkDrawerOpen(false);
      setForkedProfile(null);
      toast('Profile forked successfully', 'success');
      // Refresh profiles and switch to the forked one
      loadProfiles();
    },
    [loadProfiles],
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Ref to the composer textarea — used to focus after "quote & follow up"
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Stable "quote & follow up" handler shared by all assistant bubbles, so
  // memoized MessageBubbles don't re-render on every parent update.
  const handleQuote = useCallback((text: string, note: string) => {
    setAnnotations((prev) => [...prev, { id: `ann-${Date.now()}`, quote: text, note }]);
    setTimeout(() => chatInputRef.current?.focus(), 100);
  }, []);

  // Load profiles on mount (tools loaded lazily by profile store for fork editor)
  useEffect(() => {
    loadProfiles();
    loadTools();
  }, [loadProfiles, loadTools]);

  // Load slash prompts for internal users
  useEffect(() => {
    if (!isExternal) {
      api
        .fetchPrompts()
        .then(setSlashPrompts)
        .catch((err) => console.warn('Failed to load prompts:', err));
    }
  }, [isExternal]);

  // Track current viewing session for unread logic
  // Sync session info to global UI store (for TopBar display)
  const { setCurrentSessionInfo, setCurrentChatSessionId, bumpSessionListVersion, setChatShare } = useUIStore();
  useEffect(() => {
    setCurrentSessionInfo(
      isLoadingSession && (sessionId || localSessionId) ? t('chat.loadingHistory') : sessionTitle,
      sessionProfileId,
      sessionId ? sessionTags : [],
    );
  }, [
    isLoadingSession,
    sessionId,
    localSessionId,
    sessionTitle,
    sessionProfileId,
    sessionTags,
    setCurrentSessionInfo,
    t,
  ]);

  // Sync session ID to store (for sidebar highlight)
  useEffect(() => {
    setCurrentChatSessionId(sessionId || localSessionId);
    return () => setCurrentChatSessionId(null);
  }, [sessionId, localSessionId, setCurrentChatSessionId]);

  // Sync the Share affordance to the store so the TopBar can render the Share
  // button beside the session tags. Mirrors the old in-page button's condition.
  const canShare = !!sessionId && !isExternal && messages.length > 0;
  useEffect(() => {
    setChatShare(canShare ? { shareCount, onOpen: () => setShareDialogOpen(true) } : null);
    return () => setChatShare(null);
  }, [canShare, shareCount, setChatShare]);

  // Session-context affordance — ONLY for the public profile: it simulates the
  // context an external app caller sends via /api/v1. Shown on new chats (draft
  // mode, applied at session creation) and on owned public-profile sessions.
  const activeProfileId = sessionId ? sessionProfileId : selectedProfileId;
  // Switchable models are a per-profile policy (server-declared): only profiles
  // with model_choices (e.g. team) render the picker and send an override.
  const activeProfileMeta = displayProfiles.find((p) => p.id === activeProfileId);
  const modelChoices = getModelChoices(activeProfileMeta);
  const activeModelChoice = effectiveModelChoice(modelChoices, thinkingMode);
  const isPublicProfile = activeProfileId === 'default';
  const canEditContext = !isExternal && isPublicProfile && (sessionId ? isOwner : true);
  const contextActive = sessionId ? hasSessionContext : !!draftContext;

  // Probe whether the current session already has a context (drives chip highlight)
  useEffect(() => {
    setHasSessionContext(false);
    if (!sessionId || isExternal) return;
    api
      .getSessionContext(sessionId)
      .then((ctx) => setHasSessionContext(!!ctx))
      .catch(() => {});
  }, [sessionId, isExternal]);

  useEffect(() => {
    // Track the viewed session (cloud or desktop-local) so the SessionManager
    // can suppress the unread badge while the user is looking at it.
    const viewing = sessionId || localSessionId;
    setCurrentViewingSession(viewing);
    if (viewing) markRead(viewing);
    if (sessionId && !isExternal) {
      // Mark shared session as read
      api.markSharesReadInSession(sessionId).catch(() => {});
    }
    return () => setCurrentViewingSession(null);
  }, [sessionId, localSessionId, setCurrentViewingSession, markRead, isExternal]);

  // Set page context for global agent
  useEffect(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    enrichPageContext({
      sessionId: sessionId || localSessionId || undefined,
      lastAssistantMessageId: lastAssistant?.id,
    });
    return () => enrichPageContext(null);
  }, [sessionId, localSessionId, messages, enrichPageContext]);

  // Load session on mount/change
  useEffect(() => {
    const requestId = ++sessionLoadRequestRef.current;

    if (sessionId) {
      // Skip loading if we just created this session (first message is being sent)
      if (skipNextSessionLoadRef.current) {
        skipNextSessionLoadRef.current = false;
        setIsLoadingSession(false);
        return;
      }

      setIsLoadingSession(true);
      api
        .getSession(sessionId)
        .then((data) => {
          if (sessionLoadRequestRef.current !== requestId) return;
          setSessionTitle(data.session.title || '');
          const pid = data.session.profile_id || 'default';
          setSessionProfileId(pid);
          setSessionRating(data.session.rating ?? null);
          setSessionComment(data.session.comment ?? null);
          setSessionTags((data.session as any).tags || []);
          setMessages(data.messages.map(parseMessage));
          // Share context
          setIsOwner(data.session.is_owner !== false);
          setShareCount(data.session.share_count ?? 0);
          setShareInfo(data.share_info ?? null);
          setShareBannerDismissed(false);
        })
        .catch(() => {
          if (sessionLoadRequestRef.current === requestId) setSessionId(null);
        })
        .finally(() => {
          if (sessionLoadRequestRef.current === requestId) setIsLoadingSession(false);
        });
    } else {
      setIsLoadingSession(false);
      setMessages([]);
      setSessionTitle('');
      setSessionProfileId('default');
      setSessionRating(null);
      setSessionComment(null);
      setSessionTags([]);
      setIsOwner(true);
      setShareCount(0);
      setShareInfo(null);
      setShareBannerDismissed(false);
    }
  }, [sessionId, localSessionId]);

  // When a managed session receives a generated title via stream event, update immediately
  useEffect(() => {
    const title = activeSession?.generatedTitle;
    if (title && sessionId) {
      setSessionTitle(title);
      bumpSessionListVersion();
    }
  }, [activeSession?.generatedTitle, sessionId, bumpSessionListVersion]);

  // When the managed cloud session completes, reload the persisted messages from
  // the server BEFORE clearing the streaming overlay. The overlay keeps showing
  // the final text during the fetch (see render below), then setMessages +
  // clearSession land in a single React 19 batch — no blank gap, no flash. This
  // fires whether or not ChatPage was mounted while the turn streamed, so a turn
  // started, navigated away from, and returned to still materializes correctly.
  useEffect(() => {
    if (activeSession?.status !== 'completed' || !sessionId) return;
    const finalText = activeSession.streamText;
    const finalReasoning = activeSession.streamReasoning;
    (async () => {
      try {
        const data = await api.getSession(sessionId);
        setSessionTitle(data.session.title || '');
        setSessionRating(data.session.rating ?? null);
        setSessionComment(data.session.comment ?? null);
        const serverMessages = data.messages.map(parseMessage);
        setMessages((prev) => reconcileMessages(prev, serverMessages));
        bumpSessionListVersion();
      } catch (_err) {
        if (!finalText) return;
        const synthId = 'synth-' + Date.now();
        setMessages((prev) => [
          ...prev,
          {
            ...parseMessage({} as api.Message),
            clientKey: synthId,
            id: synthId,
            role: 'assistant',
            content: finalText,
            reasoning: finalReasoning || null,
            created_at: new Date().toISOString(),
          },
        ]);
      } finally {
        clearSession(sessionId);
      }
    })();
  }, [activeSession?.status, sessionId, clearSession, bumpSessionListVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Surface a managed cloud-session error (the SessionManager streams cloud turns,
  // so errors land on the managed session rather than the old transport callback).
  useEffect(() => {
    if (activeSession?.status === 'error' && sessionId) {
      if (activeSession.error) setError(activeSession.error);
      clearSession(sessionId);
    }
  }, [activeSession?.status, activeSession?.error, sessionId, clearSession]);

  // ─── Scroll position tracking ─────────
  // Show a "jump to latest" button when the user has scrolled up away from the bottom.
  const [showScrollButton, setShowScrollButton] = useState(false);
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Consider "at bottom" if within 80px of bottom
    const threshold = 80;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    isUserAtBottomRef.current = atBottom;
    setShowScrollButton(!atBottom); // React bails out if the value is unchanged
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (isUserAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior });
    }
  }, []);

  // Explicit "jump to latest" — overrides the at-bottom guard.
  const handleJumpToLatest = useCallback(() => {
    isUserAtBottomRef.current = true;
    setShowScrollButton(false);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Force scroll on new user message (messages array changes) or session switch
  const prevMessagesLenRef = useRef(messages.length);
  useEffect(() => {
    const addedMessages = messages.length - prevMessagesLenRef.current;
    prevMessagesLenRef.current = messages.length;
    // Always scroll when a new user message is added (user just sent)
    const lastMsg = messages[messages.length - 1];
    if (addedMessages > 0 && lastMsg?.role === 'user') {
      isUserAtBottomRef.current = true;
    }
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Scroll during streaming only if user is at bottom
  useEffect(() => {
    if (effectiveIsStreaming) {
      scrollToBottom();
    }
  }, [effectiveIsStreaming, effectiveStreamText, effectiveStreamToolCalls, scrollToBottom]);

  // Force scroll to bottom instantly on session switch.
  // Double rAF waits for the freshly-loaded messages to lay out before jumping,
  // replacing a hard-coded timeout.
  useEffect(() => {
    isUserAtBottomRef.current = true;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [sessionId, localSessionId]);

  // RAF helper for local (external) streaming
  const scheduleLocalUpdate = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      setLocalStreamText(textRef.current);
      setLocalStreamReasoning(reasoningRef.current);
      setLocalStreamToolCalls([...toolCallsRef.current]);
      rafRef.current = undefined;
    });
  }, []);

  const handleSend = useCallback(
    async (overrideMessage?: string) => {
      const rawMsg = (overrideMessage ?? input).trim();
      if (!rawMsg || effectiveIsStreaming) return;

      // Prepend annotations as numbered blockquotes if present
      let annotationPrefix = '';
      if (annotations.length > 0) {
        annotationPrefix =
          annotations
            .map((ann, i) => {
              const quoteLine = ann.quote
                .split('\n')
                .map((l) => `> ${l}`)
                .join('\n');
              const noteLine = ann.note ? `\n\n**Note ${i + 1}:** ${ann.note}` : '';
              return `**[${i + 1}]** ${quoteLine}${noteLine}`;
            })
            .join('\n\n') + '\n\n---\n\n';
      }
      const msg = annotationPrefix + rawMsg;

      if (!overrideMessage) setInput('');
      setAnnotations([]);
      // Clear draft cache for this session after sending
      sessionDrafts.delete(draftKey);
      setError(null);

      // Collect uploaded images
      const uploadedImages = pendingImages.filter((img) => img.uploaded).map((img) => img.uploaded!);

      // Clear pending images
      setPendingImages([]);

      // Create session if needed (internal cloud users only — not external)
      let sid = sessionId;
      if (!sid && !isExternal) {
        try {
          const session = await api.createSession(undefined, selectedProfileId, draftContext);
          sid = session.id;
          if (draftContext) {
            setHasSessionContext(true);
            setDraftContext(null);
          }
          // Skip the session-load effect — server has no messages yet
          skipNextSessionLoadRef.current = true;
          setSessionId(sid);
          setSessionProfileId(selectedProfileId);
          window.history.replaceState(null, '', `#/chat?session=${sid}`);
          // Notify sidebar to refresh session list
          bumpSessionListVersion();
        } catch (_err) {
          setError('Failed to create session');
          return;
        }
      }

      // Show user message immediately
      const pendingId = 'pending-' + Date.now();
      const userMsg: ParsedMessage = {
        clientKey: pendingId,
        id: pendingId,
        role: 'user',
        content: msg,
        reasoning: null,
        pipeline: [],
        references: [],
        images: uploadedImages,
        confidence: null,
        grounded: null,
        input_tokens: null,
        output_tokens: null,
        cached_tokens: null,
        reasoning_tokens: null,
        duration_ms: null,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      if (isExternal) {
        // ── External/stateless mode: local streaming (as before) ──
        setLocalIsStreaming(true);
        textRef.current = '';
        reasoningRef.current = '';
        toolCallsRef.current = [];
        setLocalStreamText('');
        setLocalStreamReasoning('');
        setLocalStreamToolCalls([]);

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        try {
          const stream = api.streamChatStateless(
            [
              ...messages.filter((m) => m.role !== 'pending').map((m) => ({ role: m.role, content: m.content })),
              { role: 'user', content: msg },
            ],
            selectedProfileId,
            abortController.signal,
          );

          for await (const event of stream) {
            handleStreamEvent(event, {
              onTextDelta: (text) => {
                textRef.current += text;
                scheduleLocalUpdate();
              },
              onReasoningDelta: (text) => {
                reasoningRef.current += text;
                scheduleLocalUpdate();
              },
              onToolCallStart: (id, toolName) => {
                toolCallsRef.current = [
                  ...toolCallsRef.current,
                  { id, name: toolName, input: '', status: 'calling' as const },
                ];
                scheduleLocalUpdate();
              },
              onToolCallDelta: (id, delta) => {
                toolCallsRef.current = toolCallsRef.current.map((tc) =>
                  tc.id === id ? { ...tc, input: tc.input + delta } : tc,
                );
                scheduleLocalUpdate();
              },
              onToolCall: (_toolName, input, id) => {
                toolCallsRef.current = toolCallsRef.current.map((tc) =>
                  tc.id === id ? { ...tc, input: JSON.stringify(input) } : tc,
                );
                scheduleLocalUpdate();
              },
              onToolResult: (id, _toolName, output) => {
                toolCallsRef.current = toolCallsRef.current.map((tc) =>
                  tc.id === id ? { ...tc, output, status: 'done' as const } : tc,
                );
                scheduleLocalUpdate();
              },
              onError: (error) => {
                setError(error);
              },
            });
          }
        } catch (err: any) {
          if (err.name !== 'AbortError') {
            setError(err.message || 'Stream failed');
          }
        }

        abortControllerRef.current = null;
        // Stateless mode has no server/local session to reload from, so the
        // streamed answer lives only in the overlay refs. Materialize it into the
        // message list before dropping the overlay (same React batch ⇒ no flash);
        // otherwise the assistant reply vanishes when the overlay unmounts.
        const finalText = textRef.current;
        const finalReasoning = reasoningRef.current;
        const finalToolCalls = toolCallsRef.current;
        if (finalText || finalReasoning || finalToolCalls.length > 0) {
          const pipeline: PipelineStep[] = finalToolCalls.map((tc, i) => ({
            step: i + 1,
            tool: tc.name,
            input: safeParse(tc.input, tc.input),
            output: tc.output,
            duration_ms: 0,
          }));
          const asstId = 'ext-' + Date.now();
          setMessages((prev) => [
            ...prev,
            {
              ...parseMessage({} as api.Message),
              clientKey: asstId,
              id: asstId,
              role: 'assistant',
              content: finalText,
              reasoning: finalReasoning || null,
              pipeline,
              created_at: new Date().toISOString(),
            },
          ]);
        }
        setLocalIsStreaming(false);
      } else {
        // ── Internal/Team mode: stream via the SessionManager (above the router)
        // so the turn keeps running and its live text stays readable after the
        // user switches to another session and back — ChatPage is keyed per
        // session and remounts on switch, so a component-local transport would be
        // disposed mid-stream and the in-progress answer lost. The manager also
        // handles the title event and any client-action (UI) tool requests.
        // Completion is materialized by the activeSession effect above. ──
        const modelOverride = modelOverrideFor(modelChoices, thinkingMode);
        sendMessage(sid!, msg, uploadedImages.length > 0 ? uploadedImages : undefined, modelOverride);
      }
    },
    [
      input,
      effectiveIsStreaming,
      sessionId,
      pendingImages,
      selectedProfileId,
      isExternal,
      messages,
      scheduleLocalUpdate,
      thinkingMode,
      modelChoices,
      annotations,
      bumpSessionListVersion,
      draftKey,
      sendMessage,
    ],
  );

  const _handleNewSession = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // Save current session's draft before switching
    const curKey = sessionId || localSessionId || DRAFT_KEY_NEW;
    if (input.trim() || annotations.length > 0) {
      sessionDrafts.set(curKey, { input, annotations, thinkingMode });
    }
    setSessionId(null);
    setMessages([]);
    setSessionTitle('');
    setSessionProfileId('default');
    setSessionRating(null);
    setSessionComment(null);
    // Restore new-session draft if exists
    const newDraft = sessionDrafts.get(DRAFT_KEY_NEW);
    setInput(newDraft?.input || '');
    setAnnotations(newDraft?.annotations || []);
    setError(null);
    setPendingImages([]);
    window.location.hash = '#/chat';
  }, [sessionId, localSessionId, input, annotations, thinkingMode]);

  // Stop streaming
  const handleStop = useCallback(() => {
    if (isExternal && abortControllerRef.current) {
      abortControllerRef.current.abort();
    } else if (sessionId) {
      // Cloud/Team turns run on the SessionManager.
      stopSession(sessionId);
    }
  }, [isExternal, sessionId, stopSession]);

  // Edit last user message and resend
  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!sessionId || effectiveIsStreaming) return;
      try {
        await api.editMessage(sessionId, messageId, newContent);
        const data = await api.getSession(sessionId);
        setMessages(data.messages.map(parseMessage));
        await handleSend(newContent);
      } catch (err: any) {
        setError(err.message || 'Edit failed');
      }
    },
    [sessionId, effectiveIsStreaming, handleSend],
  );

  // ── Image upload handlers ──
  const handleImageSelect = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files).filter((f) => f.type.startsWith('image/'));
      if (fileArray.length === 0) return;

      const remaining = MAX_IMAGES - pendingImages.length;
      const toAdd = fileArray.slice(0, remaining);
      if (toAdd.length === 0) return;

      const newImages = toAdd.map((file) => ({
        file,
        preview: URL.createObjectURL(file),
        uploading: true as const,
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

  // Drag-drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);
  const handleDropOnChat = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      if (e.dataTransfer.files.length) handleImageSelect(e.dataTransfer.files);
    },
    [handleImageSelect],
  );

  // Translate handler
  const handleTranslate = useCallback(
    async (messageId: string, targetLang: 'en' | 'zh') => {
      if (!sessionId || effectiveIsStreaming) return;
      const langLabel = targetLang === 'en' ? 'English' : '中文';
      const prompt = `Please translate the above response to ${langLabel}. Preserve all formatting (markdown, code blocks, lists, links). Only output the translated text.`;
      handleSend(prompt);
    },
    [sessionId, effectiveIsStreaming, handleSend],
  );

  // Regenerate handler
  const handleRegenerate = useCallback(
    async (_messageId: string) => {
      if (!sessionId || effectiveIsStreaming) return;
      setError(null);
      try {
        const result = await api.regenerateResponse(sessionId);
        if (result.ok && result.lastUserMessage) {
          const data = await api.getSession(sessionId);
          setMessages(data.messages.map(parseMessage));
          await handleSend(result.lastUserMessage);
        }
      } catch (err: any) {
        setError(err.message || 'Regenerate failed');
      }
    },
    [sessionId, effectiveIsStreaming, handleSend],
  );

  const hasAssistantMessage = messages.some((m) => m.role === 'assistant');

  // Navigate to a session from history sidebar
  const _handleSelectSession = useCallback(
    (sid: string) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      // Save current session's draft before switching
      const curKey = sessionId || DRAFT_KEY_NEW;
      if (input.trim() || annotations.length > 0) {
        sessionDrafts.set(curKey, { input, annotations, thinkingMode });
      }
      setSessionId(sid);
      // Draft for the target session will be restored via the draftKey effect
      setError(null);
      setPendingImages([]);
      setLocalIsStreaming(false);
      window.history.replaceState(null, '', `#/chat?session=${sid}`);
    },
    [sessionId, input, annotations, thinkingMode],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Main chat area */}
      <div
        className="flex flex-col flex-1 min-w-0 h-full relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDropOnChat}
      >
        {/* Drag-drop overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-primary-subtle/80 border-2 border-dashed border-primary-400 rounded-lg flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <span className="text-4xl mb-2 block">🖼️</span>
              <p className="text-sm font-medium text-primary-fg-strong">Drop images here</p>
              <p className="text-xs text-primary-500 mt-1">Max {MAX_IMAGES} images, auto-compressed</p>
            </div>
          </div>
        )}

        {/* Share button moved to the TopBar (next to session tags) — see TopBar. */}

        {/* Shared session banner — shown to non-owners */}
        {sessionId && shareInfo && !isOwner && !shareBannerDismissed && (
          <div className="mx-3 md:mx-4 mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-info-subtle border border-info text-sm text-info animate-fade-in">
            <Share2 size={14} className="flex-shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="font-medium">{shareInfo.shared_by_nickname}</span>
              {' shared this conversation with you'}
              {shareInfo.message && <span className="text-fg-muted"> · “{shareInfo.message}”</span>}
            </span>
            <button
              onClick={() => setShareBannerDismissed(true)}
              className="p-0.5 rounded hover:bg-surface-muted text-fg-muted hover:text-fg-secondary flex-shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Messages */}
        <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
          {/* Center the conversation to the same width as the composer (max-w-5xl)
              so the content doesn't stretch edge-to-edge on wide screens. */}
          <div className="mx-auto w-full max-w-5xl px-3 md:px-4 py-4 space-y-4">
            {isLoadingSession ? (
              <ChatHistorySkeleton label={t('chat.loadingHistory')} />
            ) : (
              messages.length === 0 &&
              !showStreamOverlay && (
                <ProfileEmptyState
                  profile={displayProfiles.find((p) => p.id === (sessionId ? sessionProfileId : selectedProfileId))}
                  onPromptClick={(prompt) => setInput((prev) => (prev ? prev + prompt : prompt))}
                />
              )
            )}

            {!isLoadingSession &&
              messages.map((msg, idx) => {
                const isLastUser = msg.role === 'user' && !messages.slice(idx + 1).some((m) => m.role === 'user');
                // Detect if this assistant message has an ask_user tool and the next message is the user's response
                const hasFollowUpUserMessage =
                  msg.role === 'assistant' &&
                  msg.pipeline?.some((s) => s.tool === 'ask_user' || (s.output as any)?.type === 'ask_user') &&
                  idx + 1 < messages.length &&
                  messages[idx + 1].role === 'user';
                // Find the previous user message for fullscreen title
                const previousUserMsg =
                  msg.role === 'assistant'
                    ? [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user')?.content
                    : undefined;
                return (
                  <MessageBubble
                    key={msg.clientKey}
                    role={msg.role}
                    content={msg.content}
                    messageId={msg.id}
                    sessionId={sessionId}
                    reasoning={msg.reasoning}
                    pipeline={msg.pipeline}
                    references={msg.references}
                    images={msg.images}
                    confidence={msg.confidence}
                    grounded={msg.grounded}
                    inputTokens={msg.input_tokens}
                    outputTokens={msg.output_tokens}
                    cachedTokens={msg.cached_tokens}
                    reasoningTokens={msg.reasoning_tokens}
                    durationMs={msg.duration_ms}
                    createdAt={msg.created_at}
                    isLastUser={isLastUser}
                    onEdit={isLastUser && !effectiveIsStreaming ? handleEditMessage : undefined}
                    onTranslate={msg.role === 'assistant' ? handleTranslate : undefined}
                    onRegenerate={msg.role === 'assistant' ? handleRegenerate : undefined}
                    onQuote={msg.role === 'assistant' ? handleQuote : undefined}
                    isStreaming={effectiveIsStreaming}
                    onAskUserSubmit={
                      msg.role === 'assistant' &&
                      msg.pipeline?.some((s) => s.tool === 'ask_user' || (s.output as any)?.type === 'ask_user')
                        ? handleSend
                        : undefined
                    }
                    onConfirmAction={msg.role === 'assistant' ? handleSend : undefined}
                    hasFollowUpUserMessage={hasFollowUpUserMessage}
                    previousUserMessage={previousUserMsg}
                  />
                );
              })}

            {!isLoadingSession &&
              showStreamOverlay &&
              (managed?.queued ? (
                // Local turn is waiting behind another (single-agent broker queue).
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-fg-muted">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-fg-faint animate-pulse" />
                  {t('chat.queuing')}
                </div>
              ) : (
                <StreamingMessageBubble
                  text={effectiveStreamText}
                  reasoning={effectiveStreamReasoning}
                  toolCalls={effectiveStreamToolCalls}
                  isStreaming={effectiveIsStreaming}
                />
              ))}

            <div ref={messagesEndRef} />

            {/* Jump-to-latest — sticks to the bottom of the scroll viewport */}
            {showScrollButton && (
              <div className="sticky bottom-2 flex justify-center pointer-events-none">
                <button
                  onClick={handleJumpToLatest}
                  className="pointer-events-auto flex items-center gap-1 px-3 py-1.5 rounded-full bg-surface-raised border border-edge shadow-md text-xs text-fg-secondary hover:text-fg hover:border-primary-300 transition-colors animate-fade-in"
                  title={t('chat.jumpToLatest')}
                >
                  <ChevronDown size={14} />
                  {effectiveIsStreaming ? t('chat.newContent') : t('chat.jumpToLatest')}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 bg-danger-subtle border-t border-danger text-xs text-danger">⚠️ {error}</div>
        )}

        {/* Input — read-only for non-owners of shared sessions, but keep feedback visible */}
        {sessionId && !isOwner ? (
          <div className="border-t border-edge bg-surface-muted flex-shrink-0">
            {hasAssistantMessage && (
              <div className="px-3 md:px-4 py-2 bg-surface-raised border-b border-edge flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-medium text-fg-muted">Feedback</span>
                  <MessageFeedback
                    messageId=""
                    sessionId={sessionId}
                    initialRating={sessionRating}
                    initialComment={sessionComment}
                    inline
                    readonly
                  />
                </div>
                <span className="text-[11px] text-fg-faint">Read only</span>
              </div>
            )}
            <div className="px-3 md:px-4 py-3">
              <div className="flex items-center justify-center gap-2 text-sm text-fg-muted py-2">
                <Eye size={14} />
                <span>
                  Shared by <span className="font-medium">{shareInfo?.shared_by_nickname}</span> · Read only
                </span>
              </div>
            </div>
          </div>
        ) : (
          <ChatInput
            input={input}
            setInput={setInput}
            isStreaming={effectiveIsStreaming}
            pendingImages={pendingImages}
            onSend={() => handleSend()}
            onStop={handleStop}
            onImageSelect={handleImageSelect}
            onRemoveImage={removeImage}
            maxImages={MAX_IMAGES}
            autoFocus
            inputRef={chatInputRef}
            slashPrompts={slashPrompts}
            profiles={displayProfiles}
            selectedProfileId={sessionId ? sessionProfileId : selectedProfileId}
            mentionEnabled={!sessionId && !isExternal && displayProfiles.length > 1}
            onMentionProfile={handleMentionProfile}
            profileChip={
              !sessionId && mentionedProfileId
                ? (displayProfiles.find((p) => p.id === mentionedProfileId) ?? null)
                : null
            }
            onRemoveProfileChip={handleRemoveProfileChip}
            chipsExtra={
              canEditContext ? (
                <button
                  type="button"
                  onClick={() => setContextDialogOpen(true)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors ${
                    contextActive
                      ? 'border-primary-edge bg-primary-subtle text-primary-fg-strong hover:bg-primary-100'
                      : 'border-edge text-fg-faint hover:text-fg-muted hover:bg-surface-muted'
                  }`}
                  title="Session context — simulate the context an external app sends via the public API"
                >
                  <SlidersHorizontal size={11} />
                  <span>Context</span>
                </button>
              ) : undefined
            }
            annotations={annotations}
            onUpdateAnnotation={(id, note) =>
              setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, note } : a)))
            }
            onDeleteAnnotation={(id) => setAnnotations((prev) => prev.filter((a) => a.id !== id))}
            onClearAnnotations={() => setAnnotations([])}
            topSlot={
              <>
                {/* Model choice picker — only for profiles that declare switchable models */}
                {modelChoices.length > 1 && (
                  <div className="flex items-center bg-surface-muted rounded-md p-0.5">
                    {modelChoices.map((choice, i) => (
                      <button
                        key={choice.id}
                        onClick={() => handleThinkingModeChange(choice.id)}
                        className={`p-1 rounded transition-colors ${
                          activeModelChoice === choice.id
                            ? 'bg-surface-raised text-primary-fg-strong shadow-sm'
                            : 'text-fg-muted hover:text-fg-secondary'
                        }`}
                        title={modelChoiceTitle(choice, t)}
                      >
                        {i === 0 ? <Zap size={13} /> : <Brain size={13} />}
                      </button>
                    ))}
                  </div>
                )}
              </>
            }
            feedbackSlot={
              sessionId && hasAssistantMessage ? (
                <MessageFeedback
                  messageId=""
                  sessionId={sessionId}
                  initialRating={sessionRating}
                  initialComment={sessionComment}
                  inline
                  readonly={!isOwner}
                />
              ) : null
            }
            rightSlot={
              <div className="flex items-center gap-1.5">
                <ProfileSelector
                  profiles={displayProfiles}
                  selectedProfileId={sessionId ? sessionProfileId : selectedProfileId}
                  onSelectProfile={handleProfileChange}
                  readonly={!!sessionId}
                  onFork={!isExternal && !sessionId ? handleFork : undefined}
                />
              </div>
            }
          />
        )}
      </div>

      {/* Share Dialog */}
      {sessionId && (
        <ShareDialog
          open={shareDialogOpen}
          onClose={() => setShareDialogOpen(false)}
          sessionId={sessionId}
          sessionTitle={sessionTitle}
          onShareChanged={() => {
            // Refresh session to get updated share_count
            api
              .getSession(sessionId)
              .then((data) => {
                setShareCount(data.session.share_count ?? 0);
                setIsOwner(data.session.is_owner !== false);
                setShareInfo(data.share_info ?? null);
              })
              .catch(() => {});
          }}
        />
      )}

      {/* Session Context Editor — sessionId null = draft mode (applied at session creation) */}
      {canEditContext && (
        <SessionContextDialog
          open={contextDialogOpen}
          onClose={() => setContextDialogOpen(false)}
          sessionId={sessionId}
          draft={draftContext}
          onChanged={(ctx) => (sessionId ? setHasSessionContext(!!ctx) : setDraftContext(ctx))}
        />
      )}

      {/* Fork Profile Editor */}
      <ProfileEditorDrawer
        open={forkDrawerOpen}
        onClose={() => {
          setForkDrawerOpen(false);
          setForkedProfile(null);
        }}
        profile={forkedProfile}
        availableTools={availableTools}
        isSuper={currentUser?.role === 'super'}
        onSave={handleForkSave}
      />
    </div>
  );
}

// ─── Profile Empty State ───────────────────────────────

function ProfileEmptyState({
  profile,
  onPromptClick,
}: {
  profile?: api.Profile;
  onPromptClick: (prompt: string) => void;
}) {
  const t = useT();
  const capabilities = profile?.capabilities;
  const hasCaps = capabilities && capabilities.length > 0;

  return (
    <div className="flex flex-col md:flex-row items-center md:items-center justify-center gap-6 md:gap-12 py-6 md:py-10 px-2 md:px-6 max-w-4xl mx-auto">
      {/* Left — Avatar + identity */}
      <div className="flex flex-col items-center text-center flex-shrink-0">
        <SproutyAvatar
          {...profileToSprouty(profile || ({ id: 'default', name: '', tools: [] } as any))}
          state="idle"
          size="xl"
          animate
        />
        <h3 className="text-lg font-medium text-fg-secondary mt-3 mb-1">
          {profile?.name || t('chat.startConversation')}
        </h3>
        {profile?.description && (
          <p className="text-sm text-fg-faint max-w-[240px] leading-snug">{profile.description}</p>
        )}
        {!profile?.description && (
          <p className="text-sm text-fg-faint max-w-[240px] leading-snug">{t('chat.defaultDescription')}</p>
        )}
      </div>

      {/* Right — Capabilities / suggested questions */}
      {hasCaps && (
        <div className="w-full md:flex-1 md:max-w-xl">
          <p className="text-[11px] font-medium text-fg-faint uppercase tracking-wider mb-2.5 text-center md:text-left">
            {t('chat.tryAsking')}
          </p>
          <div className="flex flex-col gap-1">
            {capabilities.map((cap, i) => {
              const Icon = resolveCapabilityIcon(cap.icon);
              return (
                <button
                  key={i}
                  onClick={() => onPromptClick(cap.prompt)}
                  className="w-full text-left px-3 py-2 rounded-xl border border-transparent hover:border-edge hover:bg-surface-raised/70 transition-colors text-sm text-fg-secondary flex items-center gap-3 group"
                >
                  <div className="w-7 h-7 rounded-lg bg-surface-muted group-hover:bg-primary-subtle flex items-center justify-center flex-shrink-0 transition-colors">
                    <Icon size={14} className="text-fg-faint group-hover:text-primary-fg transition-colors" />
                  </div>
                  <span className="min-w-0 truncate" title={cap.label}>
                    {cap.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────

function parseMessage(m: api.Message): ParsedMessage {
  return {
    ...m,
    clientKey: m.id,
    pipeline: safeParse(m.pipeline, []),
    references: safeParse(m.references_, []),
    images: safeParse(m.images, []),
  };
}

/**
 * Reconcile freshly-fetched server messages onto the current list without
 * remounting rows. Matches by position and preserves the existing `clientKey`,
 * so an optimistic message whose server id only just materialized keeps the
 * same React key (no unmount → no fade-in replay / layout flash).
 */
function reconcileMessages(prev: ParsedMessage[], server: ParsedMessage[]): ParsedMessage[] {
  return server.map((sm, i) => {
    const existing = prev[i];
    return existing ? { ...sm, clientKey: existing.clientKey } : sm;
  });
}
