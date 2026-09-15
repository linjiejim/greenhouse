/**
 * ConversationPane — the single conversation implementation shared by the
 * full Chat page and the context-aware Assistant overlay.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

import { MessageBubble, StreamingMessageBubble } from '../chat/message';
import { ChatInput } from '../chat/chat-input';
import type { PendingImage } from '../chat/chat-input';
import { composePromptMessage } from '../chat/prompt-selection';
import { ProfileSelector, profileToSprouty } from '../chat/profile-selector';
import { ModelSelector } from '../chat/model-selector';
import { SproutyAvatar } from '../sprouty/index.js';
import { useAgentContext } from '../agent-context';
import { useSessionManager } from '../../lib/session-manager';
import { useUIStore, useAuthStore, useProfileStore } from '../../stores';
import { getLastProfile, getLastModel, setLastModel } from '../../lib/profile-preferences';
import type { StreamingToolCall } from '../../lib/stream-events';
import type { PipelineStep } from '@greenhouse/types/session';

// ─── Per-session draft cache (in-memory, survives session switches) ─────────
interface SessionDraft {
  input: string;
  annotations: Array<{ id: string; quote: string; note: string }>;
  prompt: api.UserPrompt | null;
  skill?: SlashSkill | null;
}
const sessionDrafts = new Map<string, SessionDraft>();
const DRAFT_KEY_NEW = '__new_session__';
/** Stable empty tool-call array so the streaming overlay deps don't change every render. */
const EMPTY_TOOL_CALLS: StreamingToolCall[] = [];
import { safeParse } from '../../lib/utils';
import { AlertTriangle, Image, Paperclip, Share2, Eye, X, ChevronDown, GitFork } from '../../lib/icons';
import type { LucideIcon } from '../../lib/icons';
import * as api from '../../lib/api';
import { ShareDialog } from '../chat/share-dialog';
import { ProfileEditorDrawer } from '../chat/profile-editor';
import { Button, Skeleton, toast } from '../ui';
import { MAX_IMAGES } from '../../lib/constants';
import { TaskDock } from './task-dock';
import { WorkbenchPanel } from '../workbench/workbench-panel';
import { DEFAULT_AGENT_ID, LEGACY_AGENT_IDS } from '../../lib/agent-constants';
import { canUseFeature } from '../../lib/features';
import {
  CloudAgentDisabledError,
  createCloudAgentRun,
  getMissionRuntimeAvailability,
  type CloudAgentAttachmentRef,
  type CloudAgentRun,
  type MissionRuntimeAvailability,
} from '../../lib/api/cloud-agent';
import { acceptCloudAttachments, uploadPendingCloudAttachments } from '../cloud-agent/attachments';
import { acceptAttachments, uploadPendingAttachments, MAX_ATTACHMENTS, type PendingAttachment } from './attachments';
import { uploadChatFile, type ChatFileRef } from '../../lib/api/chat-files';
import { listSkills } from '../../lib/api/skills';
import type { SlashSkill } from '../chat/command-menu-popover';
import { useMissionSession } from './use-mission-run';
import { refreshOpenMissionPreview } from './refresh-mission-preview';
import { ForkConfirmationDialog } from './fork-confirmation-dialog';
import { useLocalized, useT } from '../../lib/i18n';
import type { AssistantLaunchRequest } from '@greenhouse/types/agent-context';
import type { ChatTurnEnvironment } from '@greenhouse/types/api';
import { snapshotClientActions } from '../../lib/client-actions/registry';
import { pageActionScopeId } from '../../lib/page-action-scope';
import type { AgentAttachment } from '../../lib/desktop/attach';
import { CONVERSATION_SURFACE_POLICIES, type ConversationSurface } from './surface-policy';
import { onComposerDraft } from '../../lib/composer-draft';
import { MissionProgressMessages } from './mission-progress-messages';
import { groupMissionOutcomes } from './mission-outcome-grouping';

export type { ConversationSurface } from './surface-policy';

type ExternalAttachmentRequest = AgentAttachment & { id: number };
type PendingForkRequest = { messageId?: string; preserveDraft: boolean };

export interface ConversationPaneProps {
  surface: ConversationSurface;
  initialSessionId?: string;
  visible?: boolean;
  viewportId?: string;
  topSlot?: React.ReactNode;
  suggestions?: Array<{ label: string; message: string; icon?: LucideIcon }>;
  launchRequest?: AssistantLaunchRequest | null;
  onLaunchConsumed?: (id: number) => void;
  onSessionChange?: (sessionId: string | null) => void;
  getTurnEnvironment?: () => ChatTurnEnvironment | undefined;
  /**
   * Files (and optionally a draft) handed in from outside the React tree — the
   * desktop shell's screenshot / selection capture. Keyed by `id` so the same
   * request is applied once even if the host re-renders with it still set.
   */
  externalAttachment?: ExternalAttachmentRequest | null;
}

/** Stored sessions may still carry retired ids; map them onto the one preset. */
function normalizeSelectedProfileId(profileId?: string | null): string {
  if (!profileId) return DEFAULT_AGENT_ID;
  if (LEGACY_AGENT_IDS.has(profileId)) return DEFAULT_AGENT_ID;
  return profileId;
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
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  duration_ms: number | null;
  model: string | null;
  created_at: string;
}

function ChatHistorySkeleton({ label }: { label: string }) {
  return (
    <div className="animate-fade-in space-y-2" aria-busy="true" aria-live="polite">
      <div className="max-w-[90%] min-w-0">
        <div className="rounded-xl border border-edge bg-surface-card px-4 py-3 shadow-sm space-y-3">
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

export function ConversationPane({
  surface,
  initialSessionId,
  visible = true,
  viewportId,
  topSlot,
  suggestions = [],
  launchRequest,
  onLaunchConsumed,
  onSessionChange,
  getTurnEnvironment,
  externalAttachment,
}: ConversationPaneProps) {
  const policy = CONVERSATION_SURFACE_POLICIES[surface];
  /**
   * Hosts that carry page context (the Assistant overlay) pass their own
   * environment. Everyone else still needs to advertise globally-registered
   * client actions — desktop native capabilities and browser automation are
   * available from the full Chat page too, and were previously invisible there
   * because this prop was the only path to `client_actions`.
   *
   * No ambient context is attached: there is no page to describe. The server
   * only requires the two scopes to match *when* ambient context is present.
   */
  const turnEnvironment = useCallback((): ChatTurnEnvironment | undefined => {
    if (getTurnEnvironment) return getTurnEnvironment();
    const scopeId = pageActionScopeId();
    const actions = snapshotClientActions(scopeId);
    return actions.length > 0 ? { clientActions: { scopeId, actions } } : undefined;
  }, [getTurnEnvironment]);
  const stableViewportId = useRef(viewportId ?? `${surface}-${Math.random().toString(36).slice(2)}`).current;
  const newDraftKey = `${DRAFT_KEY_NEW}:${stableViewportId}`;
  const t = useT();
  const currentUser = useAuthStore((s) => s.currentUser);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId || null);
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [isLoadingSession, setIsLoadingSession] = useState(() => !!initialSessionId);
  const [input, setInput] = useState('');
  const [workbenchConversationMode, setWorkbenchConversationMode] = useState(false);
  const [pendingAutoSend, setPendingAutoSend] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('');
  const [sessionProfileId, setSessionProfileId] = useState(DEFAULT_AGENT_ID);
  const [sessionRating, setSessionRating] = useState<number | null>(null);
  const [sessionComment, setSessionComment] = useState<string | null>(null);
  const [sessionTags, setSessionTags] = useState<Array<{ id: number; name: string; color: string }>>([]);
  // Workflow node/reviewer sessions (channel 'workflow') are engine-produced
  // audit records: read-only, with a link back to the orchestrating session.
  const [sessionChannel, setSessionChannel] = useState<string>('web');
  const [parentSessionId, setParentSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // /slash command state
  const [slashPrompts, setSlashPrompts] = useState<api.UserPrompt[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState<api.UserPrompt | null>(null);
  // Mission-ready skills for the `/` picker; empty without the cloud-agent feature.
  const [slashSkills, setSlashSkills] = useState<SlashSkill[]>([]);
  const [missionAvailability, setMissionAvailability] = useState<MissionRuntimeAvailability>('checking');
  // Skill attached to this draft — sending launches a Cloud Agent mission
  // directly (picking the skill + pressing send IS the human confirmation).
  const [selectedSkill, setSelectedSkill] = useState<SlashSkill | null>(null);
  // Explicitly set by Task Dock's "Add instruction" action. While present,
  // the shared composer routes its next turn straight to this Mission's
  // workspace instead of the ordinary chat agent.
  const [missionInstructionTarget, setMissionInstructionTarget] = useState<CloudAgentRun | null>(null);
  /**
   * Values typed into the selected Task's `{{variable}}` form.
   *
   * Not persisted with the draft: they belong to the task currently attached,
   * and restoring last week's "region" against a different task would be worse
   * than an empty field.
   */
  const [taskValues, setTaskValues] = useState<Record<string, string>>({});

  // Selected model for the next turn — a per-turn choice, remembered per user
  // rather than per session (see getLastModel).
  const [selectedModelId, setSelectedModelId] = useState<string | null>(() => getLastModel(currentUser?.id));

  // Selected profile, restored from the user's last choice.
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
  const modelBeforeMentionRef = useRef<string | null>(null);

  // ─── Auto-scroll: only when user is at bottom ───────────
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserAtBottomRef = useRef(true);
  const prevSessionIdRef = useRef<string | null>(sessionId);

  // Flag: skip session load when we just created it (first message scenario)
  const skipNextSessionLoadRef = useRef(false);
  const sessionLoadRequestRef = useRef(0);

  // Annotations for selection follow-up
  const [annotations, setAnnotations] = useState<Array<{ id: string; quote: string; note: string }>>([]);

  // Share dialog state
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // Share context — is the current user the session owner?
  const [isOwner, setIsOwner] = useState(true);
  const [shareCount, setShareCount] = useState(0); // -1 = team-wide
  const [shareInfo, setShareInfo] = useState<api.ShareInfo | null>(null);
  const [shareBannerDismissed, setShareBannerDismissed] = useState(false);
  const [forkingSession, setForkingSession] = useState(false);
  const [pendingFork, setPendingFork] = useState<PendingForkRequest | null>(null);

  // ─── Per-session draft: save/restore on session switch ─────────
  const draftKey = useMemo(() => sessionId || newDraftKey, [newDraftKey, sessionId]);

  // Save current draft when session changes
  useEffect(() => {
    const prevKey = prevSessionIdRef.current || newDraftKey;
    if (prevKey !== draftKey) {
      // Save previous session's draft
      sessionDrafts.set(prevKey, { input, annotations, prompt: selectedPrompt, skill: selectedSkill });
      // Restore new session's draft (or defaults)
      const draft = sessionDrafts.get(draftKey);
      if (draft) {
        setInput(draft.input);
        setAnnotations(draft.annotations);
        setSelectedPrompt(draft.prompt);
        setSelectedSkill(draft.skill ?? null);
        setTaskValues({});
      } else {
        setInput('');
        setAnnotations([]);
        setSelectedPrompt(null);
        setSelectedSkill(null);
        setTaskValues({});
      }
      // Composer @-mention is per-draft — reset on switch.
      setMissionInstructionTarget(null);
      setMentionedProfileId(null);
      profileBeforeMentionRef.current = null;
      modelBeforeMentionRef.current = null;
    }
    prevSessionIdRef.current = sessionId;
  }, [draftKey, newDraftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Image upload state
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  // Render-time mirror so handleSend can read the settled list after awaiting
  // in-flight uploads (its closure copy is stale by then).
  const pendingImagesRef = useRef<PendingImage[]>([]);
  pendingImagesRef.current = pendingImages;
  // A send arrived while images were still uploading: the send button shows a
  // spinner and the turn goes out as soon as the uploads settle.
  const [imageUploadWaiting, setImageUploadWaiting] = useState(false);
  const imageWaitGuardRef = useRef(false);
  // Mission file attachments (any type, chips above the composer; uploaded on send)
  // One pending list for both paths — the ref kind differs (mission stages a
  // blob by key, an ordinary chat writes a chat_files row by id) but the chips
  // and the picking rules do not.
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<PendingAttachment<CloudAgentAttachmentRef | ChatFileRef>>
  >([]);
  const attachmentsUploading = pendingAttachments.some((a) => a.uploading);
  // Drag-drop overlay state
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const { enrichPageContext } = useAgentContext();

  // Session Manager (global streaming state)
  const { activeSessions, markRead, clearSession, registerViewport, unregisterViewport, sendMessage, stopSession } =
    useSessionManager();

  // Background session state — used only for sessions that started streaming
  // before the user navigated here (SessionManager handles those).
  const activeSession = sessionId ? activeSessions.get(sessionId) : undefined;

  // Cloud turns run on the SessionManager, which lives above the router.
  // Reading the live stream from the managed session — rather than local component
  // state — is what lets an in-progress answer survive navigating to another
  // session and back (ChatPage is keyed per session, so it remounts on switch).
  const managed = activeSession;
  const effectiveIsStreaming = managed?.status === 'streaming';
  const effectiveIsStopping = managed?.status === 'stopping';
  const effectiveRunActive = effectiveIsStreaming || effectiveIsStopping;
  const effectiveStreamText = managed?.streamText ?? '';
  const effectiveStreamReasoning = managed?.streamReasoning ?? '';
  const effectiveStreamToolCalls = managed?.streamToolCalls ?? EMPTY_TOOL_CALLS;
  // Keep the overlay up through `completed` so the final text doesn't blink out
  // before the persisted message is reloaded (setMessages + clearSession land in
  // the same React batch — no blank gap, no flash).
  const showStreamOverlay =
    !!managed && (managed.status === 'streaming' || managed.status === 'stopping' || managed.status === 'completed');

  // Profile state — from global store (shared with settings page)
  const {
    profiles,
    models,
    fetchProfiles: loadProfiles,
    hydratePreferredProfile,
    preferredProfileIds,
    setPreferredProfile,
  } = useProfileStore();
  const displayProfiles = profiles;
  const preferenceKey = currentUser?.id || '__anonymous__';
  const preferredProfileId = preferredProfileIds[preferenceKey];

  // Tool list for profile editor (fork)
  const { availableTools, fetchTools: loadTools } = useProfileStore();

  // Update profile selection (don't override user's thinking mode preference)
  const handleModelChange = useCallback(
    (modelId: string) => {
      setSelectedModelId(modelId);
      setLastModel(modelId, currentUser?.id);
    },
    [currentUser?.id],
  );

  // The two toolbar selectors are mutually exclusive: Sprouty exposes the
  // per-turn model choice; every explicit Agent exposes its own identity.
  const activeProfile = displayProfiles.find((p) => p.id === (sessionId ? sessionProfileId : selectedProfileId));

  const handleProfileChange = useCallback(
    (profileId: string) => {
      setSelectedProfileId(profileId);
      setPreferredProfile(profileId, currentUser?.id);
      // Selecting an explicit Agent adopts its authored model before the model
      // picker disappears, instead of carrying over Sprouty's last engine.
      const profileModel = displayProfiles.find((p) => p.id === profileId)?.model_id;
      if (profileModel && models.some((m) => m.id === profileModel)) setSelectedModelId(profileModel);
      // A manual toolbar change supersedes any @-mention pill.
      setMentionedProfileId(null);
      profileBeforeMentionRef.current = null;
      modelBeforeMentionRef.current = null;
    },
    [currentUser?.id, setPreferredProfile, displayProfiles, models],
  );

  // ── Composer @-mention / activations ──────────────────────────────
  // @-mention a profile: switch the active profile and surface it as a pill.
  // Don't persist it as the user's "last profile" — it's a per-draft choice.
  const handleMentionProfile = useCallback(
    (profileId: string) => {
      setMentionedProfileId((prev) => {
        if (prev === null) {
          profileBeforeMentionRef.current = selectedProfileId;
          modelBeforeMentionRef.current = selectedModelId;
        }
        return profileId;
      });
      setSelectedProfileId(profileId);
      const profileModel = displayProfiles.find((p) => p.id === profileId)?.model_id;
      if (profileModel && models.some((model) => model.id === profileModel)) setSelectedModelId(profileModel);
    },
    [displayProfiles, models, selectedModelId, selectedProfileId],
  );

  // Remove the profile pill → revert to the profile active before the mention.
  const handleRemoveProfileChip = useCallback(() => {
    const prev =
      profileBeforeMentionRef.current ??
      normalizeSelectedProfileId(preferredProfileId ?? getLastProfile(currentUser?.id));
    setSelectedProfileId(prev);
    if (modelBeforeMentionRef.current) setSelectedModelId(modelBeforeMentionRef.current);
    setMentionedProfileId(null);
    profileBeforeMentionRef.current = null;
    modelBeforeMentionRef.current = null;
  }, [currentUser?.id, preferredProfileId]);

  // Fork profile state
  const [forkDrawerOpen, setForkDrawerOpen] = useState(false);
  const [forkedProfile, setForkedProfile] = useState<api.Profile | null>(null);

  const handleFork = useCallback(async (profileId: string) => {
    try {
      const forked = await api.forkProfile(profileId);
      setForkedProfile(forked);
      setForkDrawerOpen(true);
    } catch (err: any) {
      toast(err.message || 'Failed to fork Agent', 'error');
    }
  }, []);

  const handleForkSave = useCallback(
    async (input: api.CustomProfileInput, editId?: number) => {
      if (editId !== undefined) {
        await api.updateCustomProfile(editId, input);
      }
      setForkDrawerOpen(false);
      setForkedProfile(null);
      toast('Agent forked successfully', 'success');
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
    if (policy.showProfileManagement) loadTools();
  }, [loadProfiles, loadTools, policy.showProfileManagement]);

  useEffect(() => {
    const persisted = hydratePreferredProfile(currentUser?.id);
    if (!mentionedProfileId) setSelectedProfileId(normalizeSelectedProfileId(persisted));
  }, [currentUser?.id, hydratePreferredProfile, mentionedProfileId]);

  useEffect(() => {
    if (mentionedProfileId || preferredProfileId === undefined) return;
    setSelectedProfileId(normalizeSelectedProfileId(preferredProfileId));
  }, [mentionedProfileId, preferredProfileId]);

  // Load slash prompts.
  useEffect(() => {
    api
      .fetchPrompts()
      .then(setSlashPrompts)
      .catch((err) => console.warn('Failed to load prompts:', err));
  }, []);

  // Check admission before exposing launchable skills. A feature-enabled user
  // should see an explicit unavailable row instead of selecting a skill and
  // learning about the closed runtime only after POST returns 503.
  const canLaunchMissions = canUseFeature(currentUser, 'cloud-agent');
  useEffect(() => {
    if (!canLaunchMissions) {
      setSlashSkills([]);
      return;
    }
    let disposed = false;
    setMissionAvailability('checking');
    setSlashSkills([]);
    void (async () => {
      try {
        const availability = await getMissionRuntimeAvailability();
        if (disposed) return;
        setMissionAvailability(availability);
        if (availability !== 'ready') return;

        // Paged to the full catalog — a truncated list would hide launchable
        // skills while the sandbox happily mounts them.
        const PAGE = 100;
        const all = [];
        for (let offset = 0; ; offset += PAGE) {
          const { skills, total } = await listSkills({ status: 'active', limit: PAGE, offset });
          all.push(...skills);
          if (all.length >= total || skills.length === 0) break;
        }
        if (disposed) return;
        setSlashSkills(
          all
            .filter((s) => s.slash_selectable && s.source_group)
            .map((s) => ({
              name: s.name,
              display_name: s.display_name,
              description: s.description,
              group: s.source_group!,
            })),
        );
      } catch (err) {
        if (!disposed) {
          setMissionAvailability('unavailable');
          setSlashSkills([]);
        }
        console.warn('Failed to load skills:', err);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [canLaunchMissions]);

  // Track current viewing session for unread logic
  // Sync session info to global UI store (for TopBar display)
  const {
    setCurrentSessionInfo,
    setCurrentChatSessionId,
    bumpSessionListVersion,
    setChatShare,
    setChatFeedback,
    setChatTitleEdit,
  } = useUIStore();
  const handleRenameSessionTitle = useCallback(
    async (nextTitle: string) => {
      const title = nextTitle.trim();
      if (!sessionId || !isOwner || sessionChannel !== 'web' || !title || title === sessionTitle) return;
      await api.updateSession(sessionId, { title });
      setSessionTitle(title);
      setCurrentSessionInfo(title, sessionProfileId, sessionTags);
      bumpSessionListVersion();
    },
    [
      bumpSessionListVersion,
      isOwner,
      sessionChannel,
      sessionId,
      sessionProfileId,
      sessionTags,
      sessionTitle,
      setCurrentSessionInfo,
    ],
  );
  useEffect(() => {
    if (!policy.publishGlobalChatUi) return;
    setCurrentSessionInfo(
      isLoadingSession && sessionId ? t('chat.loadingHistory') : sessionTitle,
      // Keep the global snapshot complete for non-TopBar consumers even though
      // the title bar itself no longer repeats the active Agent.
      sessionId ? sessionProfileId : selectedProfileId,
      sessionTags,
    );
  }, [
    isLoadingSession,
    sessionId,
    sessionTitle,
    sessionProfileId,
    selectedProfileId,
    sessionTags,
    setCurrentSessionInfo,
    t,
    policy.publishGlobalChatUi,
  ]);

  // Sync session ID to store (for sidebar highlight)
  useEffect(() => {
    if (!policy.publishGlobalChatUi) return;
    setCurrentChatSessionId(sessionId);
    return () => setCurrentChatSessionId(null);
  }, [policy.publishGlobalChatUi, sessionId, setCurrentChatSessionId]);

  // Sync the Share affordance to the store so the TopBar can render the Share
  // button beside the session tags. Mirrors the old in-page button's condition.
  const canShare = !!sessionId && messages.length > 0;
  const hasAssistantMessage = messages.some((message) => message.role === 'assistant');
  useEffect(() => {
    if (!policy.showShare) return;
    setChatShare(canShare ? { shareCount, onOpen: () => setShareDialogOpen(true) } : null);
    return () => setChatShare(null);
  }, [canShare, policy.showShare, shareCount, setChatShare]);

  useEffect(() => {
    if (!policy.publishGlobalChatUi || !policy.showFeedback) return;
    setChatFeedback(
      sessionId && hasAssistantMessage
        ? {
            sessionId,
            initialRating: sessionRating,
            initialComment: sessionComment,
            readonly: !isOwner,
          }
        : null,
    );
    return () => setChatFeedback(null);
  }, [
    hasAssistantMessage,
    isOwner,
    policy.publishGlobalChatUi,
    policy.showFeedback,
    sessionComment,
    sessionId,
    sessionRating,
    setChatFeedback,
  ]);

  useEffect(() => {
    if (!policy.publishGlobalChatUi) return;
    setChatTitleEdit(
      sessionId
        ? {
            readonly: !isOwner || sessionChannel !== 'web',
            onRename: handleRenameSessionTitle,
          }
        : null,
    );
    return () => setChatTitleEdit(null);
  }, [handleRenameSessionTitle, isOwner, policy.publishGlobalChatUi, sessionChannel, sessionId, setChatTitleEdit]);

  useEffect(() => {
    registerViewport(stableViewportId, sessionId, visible);
    if (sessionId) markRead(sessionId);
    if (sessionId && visible) {
      // Mark shared session as read
      api.markSharesReadInSession(sessionId).catch(() => {});
    }
  }, [markRead, registerViewport, sessionId, stableViewportId, visible]);

  useEffect(() => () => unregisterViewport(stableViewportId), [stableViewportId, unregisterViewport]);

  useEffect(() => {
    onSessionChange?.(sessionId);
  }, [onSessionChange, sessionId]);

  // Publish the full Chat page as optional context for the Assistant overlay.
  useEffect(() => {
    if (!policy.enrichPageContext) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    enrichPageContext({
      sessionId: sessionId || undefined,
      lastAssistantMessageId: lastAssistant?.id,
    });
    return () => enrichPageContext(null);
  }, [enrichPageContext, messages, policy.enrichPageContext, sessionId]);

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
          const pid = normalizeSelectedProfileId(data.session.profile_id);
          setSessionProfileId(pid);
          setSessionRating(data.session.rating ?? null);
          setSessionComment(data.session.comment ?? null);
          setSessionTags((data.session as any).tags || []);
          setSessionChannel(data.session.channel ?? 'web');
          setParentSessionId(data.session.parent_session_id ?? null);
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
      setSessionProfileId(DEFAULT_AGENT_ID);
      setSessionRating(null);
      setSessionComment(null);
      setSessionTags([]);
      setSessionChannel('web');
      setParentSessionId(null);
      setIsOwner(true);
      setShareCount(0);
      setShareInfo(null);
      setShareBannerDismissed(false);
    }
  }, [sessionId]);

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
    if (activeSession?.status !== 'error' || !sessionId) return;
    let cancelled = false;
    if (activeSession.error) setError(activeSession.error);

    void (async () => {
      try {
        // The API closes an errored stream only after persisting a safe partial
        // assistant message. Reload it before removing the in-memory overlay.
        const data = await api.getSession(sessionId);
        if (cancelled) return;
        setMessages((prev) => reconcileMessages(prev, data.messages.map(parseMessage)));
        bumpSessionListVersion();
      } catch {
        // Keep the visible error; a later session reload can still recover the
        // server-side message if this one request failed.
      } finally {
        if (!cancelled) clearSession(sessionId);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSession?.status, activeSession?.error, sessionId, clearSession, bumpSessionListVersion]);

  // ── Mission conversations (the retired `sprouty-mission` preset) ─────────
  // Judged by CHANNEL, not profile: the channel is the durable fact the server
  // stamped, and the profile id is now normalized away. No new ones are
  // created — a mission is dispatched from any conversation — but the ones
  // that exist keep working: sends route to POST /api/cloud-agent/runs and
  // both turns stay server-written (integration spec D1/D2).
  const isMissionConversation = sessionChannel === 'mission';

  // A background task (mission or workflow) reached a terminal state, so the
  // server has written its outcome message — reload the transcript to show it.
  const reloadSettledTranscript = useCallback(() => {
    if (!sessionId) return;
    void api
      .getSession(sessionId)
      .then((data) => {
        setSessionTitle(data.session.title || '');
        setMessages((prev) => reconcileMessages(prev, data.messages.map(parseMessage)));
        bumpSessionListVersion();
      })
      .catch(() => {
        // Keep the current view; the next session load recovers the message.
      });
  }, [sessionId, bumpSessionListVersion]);

  // A MISSION run specifically settled: reload the transcript AND, if the side
  // pane is showing an HTML artifact this run rewrote, swap in the fresh bytes.
  // That is what makes "edit the deck by chatting" show up in the open preview
  // without the user hunting for the new artifact card (workflow settles reuse
  // reloadSettledTranscript directly — they have no HTML preview to refresh).
  const handleMissionRunSettled = useCallback(
    (settledRunId: string) => {
      reloadSettledTranscript();
      void refreshOpenMissionPreview(settledRunId);
    },
    [reloadSettledTranscript],
  );

  // Mission runs are no longer exclusive to the mission preset: `mission_dispatch`
  // can launch one from an ordinary chat, so the run lineage is observed for ANY
  // conversation of a cloud-agent user. The preset-specific behaviors below
  // (composer lockout, routing sends to /api/cloud-agent) stay keyed on
  // `isMissionConversation` — in an ordinary chat the composer keeps talking to
  // the chat agent while a mission runs in the background (session-modes D8).
  const mission = useMissionSession({
    sessionId,
    enabled: !!sessionId && canUseFeature(currentUser, 'cloud-agent'),
    onRunSettled: handleMissionRunSettled,
  });
  const {
    runs: missionRuns,
    activeRun: missionActiveRun,
    latestRun: missionLatestRun,
    loaded: missionLoaded,
    trackRun: trackMissionRun,
  } = mission;
  const groupedMissionOutcomes = useMemo(() => groupMissionOutcomes(messages, missionRuns), [messages, missionRuns]);

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

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      // The empty state is not a transcript: it holds the workbench, and its
      // "end" is the bottom of a dashboard the user has not read yet. Jumping
      // there on mount (or whenever a card finishes loading and the content
      // grows) would hide the top of their own home page.
      if (messages.length === 0) return;
      if (isUserAtBottomRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior });
      }
    },
    [messages.length],
  );

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

  // Follow the mission progress card as its timeline grows (at-bottom guarded).
  useEffect(() => {
    if (mission.activeRun) scrollToBottom();
  }, [mission.activeRun, mission.events, scrollToBottom]);

  // Force scroll to bottom instantly on session switch.
  // Double rAF waits for the freshly-loaded messages to lay out before jumping,
  // replacing a hard-coded timeout.
  useEffect(() => {
    isUserAtBottomRef.current = true;
    // A new conversation has no transcript to land at the end of — it opens on
    // the workbench, which must start at the top.
    if (!sessionId) return;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [sessionId]);

  const handleSend = useCallback(
    async (overrideMessage?: string) => {
      const isComposerSend = overrideMessage === undefined;
      const composerMessage = composePromptMessage(input, selectedPrompt, taskValues);
      const rawMsg = (isComposerSend ? composerMessage : (overrideMessage ?? '')).trim();
      // A skill chip sends with an empty brief — the skill's own SKILL.md is
      // the task then (only composer sends carry the chip).
      const skillLaunch = isComposerSend && selectedSkill ? selectedSkill : null;
      const missionInstruction = isComposerSend ? missionInstructionTarget : null;
      if ((!rawMsg && !skillLaunch) || effectiveRunActive) return;

      if ((skillLaunch || missionInstruction) && missionAvailability !== 'ready') {
        setError(t('cloudAgent.runtimeDisabled'));
        return;
      }

      // Missions have no inline-image path — images staged before the skill
      // was picked would be silently dropped; make the user decide.
      if ((skillLaunch || missionInstruction) && !isMissionConversation && pendingImages.length > 0) {
        toast(t('chat.skillMissionImagesHint'), 'info');
        return;
      }

      // One active run per user is enforced server-side; surface a hint
      // instead of letting the send race the in-flight mission turn.
      if (isMissionConversation && (missionActiveRun || (sessionId && !missionLoaded))) {
        toast(t('chat.missionRunActiveHint'), 'info');
        return;
      }

      // Upload pending mission attachments BEFORE touching the draft: a failed
      // upload keeps the input and chips intact (failed chips carry the error;
      // a retried send re-uploads only those, uploaded ones reuse their ref).
      let missionAttachments: CloudAgentAttachmentRef[] | undefined;
      if (isMissionConversation && pendingAttachments.length > 0) {
        if (attachmentsUploading) return;
        const refs = await uploadPendingCloudAttachments(
          pendingAttachments as Array<PendingAttachment<CloudAgentAttachmentRef>>,
          setPendingAttachments as React.Dispatch<
            React.SetStateAction<Array<PendingAttachment<CloudAgentAttachmentRef>>>
          >,
        );
        if (!refs) {
          toast(t('cloudAgent.attachmentUploadFailed'), 'error');
          return;
        }
        missionAttachments = refs;
      }

      // Images upload as soon as they are picked, and this send used to keep
      // only the ones already done (`filter(img => img.uploaded)`) — a send
      // landing mid-upload silently dropped the rest. Wait for them instead:
      // the send button spins, and the turn goes out with every image. Runs
      // BEFORE the draft is cleared so a failed upload keeps input + chips.
      if (pendingImages.some((img) => img.uploading)) {
        if (imageWaitGuardRef.current) return; // Enter mashed during the wait
        imageWaitGuardRef.current = true;
        setImageUploadWaiting(true);
        try {
          while (pendingImagesRef.current.some((img) => img.uploading)) {
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
        } finally {
          imageWaitGuardRef.current = false;
          setImageUploadWaiting(false);
        }
      }
      if (pendingImagesRef.current.some((img) => img.error)) {
        // The failed chip stays visible (danger overlay) — remove it or retry.
        toast(t('chat.imageUploadFailed'), 'error');
        return;
      }

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
      const workbenchAwareMessage = workbenchConversationMode
        ? t('home.chatEditInstruction', { instruction: rawMsg })
        : rawMsg;
      const msg = annotationPrefix + workbenchAwareMessage;

      // Direct `/Skill` launch from an ordinary Chat is one admission request.
      // New conversations are created by that request, after every launch
      // validation has passed, so a rejected Mission cannot leave an empty
      // "Untitled" session behind. Keep the draft and chips untouched until
      // the server accepts the run.
      if (skillLaunch && !isMissionConversation) {
        let stagedAttachments: CloudAgentAttachmentRef[] | undefined;
        let chatFileIds: string[] | undefined;
        let optimisticContent = msg;

        if (pendingAttachments.length > 0) {
          if (attachmentsUploading) return;
          if (sessionId) {
            const refs = await uploadPendingAttachments(pendingAttachments, setPendingAttachments, (file) =>
              uploadChatFile(sessionId, file),
            );
            if (!refs) {
              toast(t('cloudAgent.attachmentUploadFailed'), 'error');
              return;
            }
            const chips = refs.map((item) => {
              const ref = item as ChatFileRef;
              return { id: ref.id, name: ref.name, size_bytes: ref.size };
            });
            chatFileIds = chips.map((chip) => chip.id);
            const fence = `\`\`\`attachments\n${JSON.stringify(chips)}\n\`\`\``;
            optimisticContent = [msg, fence].filter(Boolean).join('\n\n');
          } else {
            const refs = await uploadPendingCloudAttachments(
              pendingAttachments as Array<PendingAttachment<CloudAgentAttachmentRef>>,
              setPendingAttachments as React.Dispatch<
                React.SetStateAction<Array<PendingAttachment<CloudAgentAttachmentRef>>>
              >,
            );
            if (!refs) {
              toast(t('cloudAgent.attachmentUploadFailed'), 'error');
              return;
            }
            stagedAttachments = refs;
          }
        }

        const pendingId = `pending-${Date.now()}`;
        if (optimisticContent.trim()) {
          setMessages((prev) => [
            ...prev,
            {
              clientKey: pendingId,
              id: pendingId,
              role: 'user',
              content: optimisticContent,
              reasoning: null,
              pipeline: [],
              references: [],
              images: [],
              input_tokens: null,
              output_tokens: null,
              cached_tokens: null,
              reasoning_tokens: null,
              duration_ms: null,
              model: null,
              created_at: new Date().toISOString(),
            },
          ]);
        }
        setError(null);

        try {
          const run = await createCloudAgentRun({
            prompt: msg,
            skill: skillLaunch.name,
            write_user_turn: true,
            ...(sessionId ? { session_id: sessionId } : { create_session_profile_id: selectedProfileId }),
            ...(stagedAttachments?.length ? { attachments: stagedAttachments } : {}),
            ...(chatFileIds?.length ? { chat_file_ids: chatFileIds } : {}),
            ...(selectedModelId ? { model: selectedModelId } : {}),
          });
          const acceptedSessionId = run.session_id;
          if (!acceptedSessionId) throw new Error(t('cloudAgent.createFailed'));

          setInput('');
          setSelectedPrompt(null);
          setSelectedSkill(null);
          setTaskValues({});
          setAnnotations([]);
          sessionDrafts.delete(draftKey);
          setPendingImages([]);
          setPendingAttachments([]);

          if (!sessionId) {
            skipNextSessionLoadRef.current = true;
            setSessionId(acceptedSessionId);
            setSessionProfileId(selectedProfileId);
            if (policy.publishGlobalChatUi) {
              window.history.replaceState(null, '', `#/chat?session=${acceptedSessionId}`);
            }
          }
          trackMissionRun(run);
          try {
            const data = await api.getSession(acceptedSessionId);
            setSessionTitle(data.session.title || '');
            setMessages((prev) => reconcileMessages(prev, data.messages.map(parseMessage)));
          } catch {
            // The optimistic row stands in until the next session load.
          }
          bumpSessionListVersion();
        } catch (err) {
          setMessages((prev) => prev.filter((message) => message.clientKey !== pendingId));
          if (err instanceof CloudAgentDisabledError) {
            setMissionAvailability('unavailable');
            setSlashSkills([]);
            setError(t('cloudAgent.runtimeDisabled'));
          } else {
            setError(err instanceof Error ? err.message : t('cloudAgent.createFailed'));
          }
        }
        return;
      }

      // Task Dock's "Add instruction" reuses the real composer, but the chip
      // makes its routing explicit: this turn goes straight to the Mission
      // workspace and is persisted as the user's next transcript message. It
      // may queue behind an active run; the controller owns that ordering.
      if (missionInstruction && !isMissionConversation) {
        if (!sessionId) {
          setMissionInstructionTarget(null);
          setError(t('cloudAgent.createFailed'));
          return;
        }

        let chatFileIds: string[] | undefined;
        let optimisticContent = msg;
        if (pendingAttachments.length > 0) {
          if (attachmentsUploading) return;
          const refs = await uploadPendingAttachments(pendingAttachments, setPendingAttachments, (file) =>
            uploadChatFile(sessionId, file),
          );
          if (!refs) {
            toast(t('cloudAgent.attachmentUploadFailed'), 'error');
            return;
          }
          const chips = refs.map((item) => {
            const ref = item as ChatFileRef;
            return { id: ref.id, name: ref.name, size_bytes: ref.size };
          });
          chatFileIds = chips.map((chip) => chip.id);
          const fence = `\`\`\`attachments\n${JSON.stringify(chips)}\n\`\`\``;
          optimisticContent = [msg, fence].filter(Boolean).join('\n\n');
        }

        const pendingId = `pending-${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          {
            clientKey: pendingId,
            id: pendingId,
            role: 'user',
            content: optimisticContent,
            reasoning: null,
            pipeline: [],
            references: [],
            images: [],
            input_tokens: null,
            output_tokens: null,
            cached_tokens: null,
            reasoning_tokens: null,
            duration_ms: null,
            model: null,
            created_at: new Date().toISOString(),
          },
        ]);
        setError(null);

        try {
          const run = await createCloudAgentRun({
            prompt: msg,
            session_id: sessionId,
            workspace_id: missionInstruction.workspace_id,
            model: missionInstruction.model,
            write_user_turn: true,
            ...(chatFileIds?.length ? { chat_file_ids: chatFileIds } : {}),
          });

          setInput('');
          setSelectedPrompt(null);
          setSelectedSkill(null);
          setMissionInstructionTarget(null);
          setTaskValues({});
          setAnnotations([]);
          sessionDrafts.delete(draftKey);
          setPendingImages([]);
          setPendingAttachments([]);
          trackMissionRun(run);
          try {
            const data = await api.getSession(sessionId);
            setMessages((prev) => reconcileMessages(prev, data.messages.map(parseMessage)));
          } catch {
            // The optimistic row stands in until the next session load.
          }
          bumpSessionListVersion();
        } catch (err) {
          setMessages((prev) => prev.filter((message) => message.clientKey !== pendingId));
          if (err instanceof CloudAgentDisabledError) {
            setMissionAvailability('unavailable');
            setSlashSkills([]);
            setError(t('cloudAgent.runtimeDisabled'));
          } else {
            setError(err instanceof Error ? err.message : t('cloudAgent.createFailed'));
          }
        }
        return;
      }

      if (isComposerSend) {
        setInput('');
        setSelectedPrompt(null);
        setSelectedSkill(null);
        setTaskValues({});
      }
      setAnnotations([]);
      // Clear draft cache for this session after sending
      sessionDrafts.delete(draftKey);
      setError(null);

      // Collect uploaded images — from the ref, not the closure: the list the
      // upload-wait above settled on is newer than this callback's snapshot.
      const uploadedImages = pendingImagesRef.current.filter((img) => img.uploaded).map((img) => img.uploaded!);

      // Clear pending images
      setPendingImages([]);

      // Create a cloud session when needed.
      let sid = sessionId;
      if (!sid) {
        try {
          const session = await api.createSession(undefined, selectedProfileId);
          sid = session.id;
          // Skip the session-load effect — server has no messages yet
          skipNextSessionLoadRef.current = true;
          setSessionId(sid);
          setSessionProfileId(selectedProfileId);
          if (policy.publishGlobalChatUi) window.history.replaceState(null, '', `#/chat?session=${sid}`);
          // Notify sidebar to refresh session list
          bumpSessionListVersion();
        } catch (_err) {
          if (isComposerSend) {
            setInput(input);
            setSelectedPrompt(selectedPrompt);
            setSelectedSkill(selectedSkill);
          }
          setError('Failed to create session');
          return;
        }
      }

      // Chat attachments upload only once the session exists — a chat_files row
      // is session-owned, unlike a mission staging blob (which is user-owned and
      // could go earlier). The refs ride into the turn as an ```attachments
      // fence: it renders as chips, and it is also how the model learns the ids
      // it can pass to read_attachment.
      let msgWithAttachments = msg;
      if (!isMissionConversation && pendingAttachments.length > 0) {
        if (attachmentsUploading) return;
        const refs = await uploadPendingAttachments(pendingAttachments, setPendingAttachments, (file) =>
          uploadChatFile(sid!, file),
        );
        if (!refs) {
          toast(t('cloudAgent.attachmentUploadFailed'), 'error');
          return;
        }
        const chips = refs.map((item) => {
          const ref = item as ChatFileRef;
          return { id: ref.id, name: ref.name, size_bytes: ref.size };
        });
        msgWithAttachments = msg
          ? `${msg}\n\n\`\`\`attachments\n${JSON.stringify(chips)}\n\`\`\``
          : `\`\`\`attachments\n${JSON.stringify(chips)}\n\`\`\``;
        setPendingAttachments([]);
      }

      // Show user message immediately (an empty-brief skill launch has nothing
      // to show — the server writes no user turn for it either)
      const pendingId = 'pending-' + Date.now();
      if (msgWithAttachments.trim()) {
        const userMsg: ParsedMessage = {
          clientKey: pendingId,
          id: pendingId,
          role: 'user',
          content: msgWithAttachments,
          reasoning: null,
          pipeline: [],
          references: [],
          images: uploadedImages,
          input_tokens: null,
          output_tokens: null,
          cached_tokens: null,
          reasoning_tokens: null,
          duration_ms: null,
          model: null,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, userMsg]);
      }

      // Mission conversations enqueue a Cloud Agent run instead of streaming
      // through /api/chat. The server writes the user turn on enqueue and the
      // assistant outcome on the run's terminal state — reload, never persist.
      if (isMissionConversation) {
        try {
          const run = await createCloudAgentRun({
            prompt: msg,
            ...(skillLaunch ? { skill: skillLaunch.name } : {}),
            session_id: sid!,
            ...(missionAttachments && missionAttachments.length > 0 ? { attachments: missionAttachments } : {}),
            // Follow-up turns reuse the session's workspace (and its model) so
            // the agent keeps the previous rounds' context and artifacts.
            ...(missionLatestRun ? { workspace_id: missionLatestRun.workspace_id, model: missionLatestRun.model } : {}),
          });
          setPendingAttachments([]);
          trackMissionRun(run);
          try {
            const data = await api.getSession(sid!);
            setMessages((prev) => reconcileMessages(prev, data.messages.map(parseMessage)));
          } catch {
            // The optimistic row stands in until the next session load.
          }
          bumpSessionListVersion();
        } catch (err) {
          setMessages((prev) => prev.filter((m) => m.clientKey !== pendingId));
          if (isComposerSend) {
            setInput(input);
            setSelectedPrompt(selectedPrompt);
            setSelectedSkill(selectedSkill);
          }
          if (err instanceof CloudAgentDisabledError) setError(t('cloudAgent.runtimeDisabled'));
          else setError(err instanceof Error ? err.message : t('cloudAgent.createFailed'));
        }
        return;
      }

      // Stream via the SessionManager (above the router) so the turn keeps
      // running when the user switches sessions. Browser Client Actions are
      // handled by the manager and completion is materialized above.
      sendMessage(sid!, msgWithAttachments, uploadedImages.length > 0 ? uploadedImages : undefined, {
        ...turnEnvironment(),
        ...(selectedModelId ? { model: selectedModelId } : {}),
      });
    },
    [
      input,
      selectedPrompt,
      selectedSkill,
      missionInstructionTarget,
      taskValues,
      selectedModelId,
      effectiveRunActive,
      isMissionConversation,
      missionActiveRun,
      missionLatestRun,
      missionLoaded,
      trackMissionRun,
      missionAvailability,
      sessionId,
      pendingImages,
      pendingAttachments,
      attachmentsUploading,
      selectedProfileId,
      annotations,
      bumpSessionListVersion,
      draftKey,
      turnEnvironment,
      policy.publishGlobalChatUi,
      sendMessage,
      t,
      workbenchConversationMode,
    ],
  );

  const lastLaunchRequestIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!launchRequest || lastLaunchRequestIdRef.current === launchRequest.id) return;
    lastLaunchRequestIdRef.current = launchRequest.id;

    const startsNew = launchRequest.newConversation || (!!launchRequest.profileId && !launchRequest.sessionId);
    const targetSessionId = launchRequest.sessionId ?? (startsNew ? null : sessionId);
    const targetDraftKey = targetSessionId || newDraftKey;

    if (launchRequest.draft) {
      sessionDrafts.set(targetDraftKey, { input: launchRequest.draft, annotations: [], prompt: null });
      setInput(launchRequest.draft);
      setAnnotations([]);
      setSelectedPrompt(null);
      setTaskValues({});
      if (launchRequest.autoSend) setPendingAutoSend(launchRequest.draft);
    }
    if (launchRequest.profileId) {
      setSelectedProfileId(normalizeSelectedProfileId(launchRequest.profileId));
      setPreferredProfile(normalizeSelectedProfileId(launchRequest.profileId), currentUser?.id);
    }
    if (targetSessionId !== sessionId) {
      setSessionId(targetSessionId);
      setMessages([]);
      setError(null);
      setPendingImages([]);
    }

    onLaunchConsumed?.(launchRequest.id);
  }, [currentUser?.id, launchRequest, newDraftKey, onLaunchConsumed, sessionId, setPreferredProfile]);

  useEffect(() => {
    if (!pendingAutoSend || isLoadingSession || effectiveRunActive) return;
    const message = pendingAutoSend;
    setPendingAutoSend(null);
    void handleSend(message);
  }, [effectiveRunActive, handleSend, isLoadingSession, pendingAutoSend]);

  // Stop streaming
  const handleStop = useCallback(() => {
    if (sessionId) stopSession(sessionId);
  }, [sessionId, stopSession]);

  // Edit last user message and resend
  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!sessionId || effectiveRunActive) return;
      try {
        await api.editMessage(sessionId, messageId, newContent);
        const data = await api.getSession(sessionId);
        setMessages(data.messages.map(parseMessage));
        await handleSend(newContent);
      } catch (err: any) {
        setError(err.message || 'Edit failed');
      }
    },
    [sessionId, effectiveRunActive, handleSend],
  );

  // ── Image upload handlers ──
  const handleImageSelect = useCallback(
    async (files: FileList | File[]) => {
      // Mission prompts are text-only — drop drag/paste images silently.
      if (isMissionConversation) return;
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
    [isMissionConversation, pendingImages.length],
  );

  /**
   * A turn staged by something outside the conversation — today the image
   * annotator, which uploads its flattened result and then needs it to land in
   * this composer.
   *
   * Deliberately staged, never sent: the drawing says where, the user still
   * gets to say what. Auto-sending would make one mis-drawn circle cost a full
   * image generation.
   */
  useEffect(
    () =>
      onComposerDraft((incoming) => {
        setInput(incoming.text);
        setPendingImages((prev) => [
          ...prev,
          ...incoming.images.map((image) => ({
            // No File — these bytes are already in storage; the send path only
            // reads `uploaded`, and re-uploading would double-charge.
            file: new File([], `${image.id}.png`, { type: 'image/png' }),
            preview: image.url,
            uploading: false as const,
            uploaded: image,
          })),
        ]);
      }),
    [],
  );

  const lastExternalAttachmentIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!externalAttachment || lastExternalAttachmentIdRef.current === externalAttachment.id) return;
    lastExternalAttachmentIdRef.current = externalAttachment.id;

    void (async () => {
      if (externalAttachment.files?.length) {
        // Same path as a pasted or dropped image: one attachment path, not two.
        await handleImageSelect(externalAttachment.files);
      }
      if (externalAttachment.draft) {
        sessionDrafts.set(draftKey, { input: externalAttachment.draft, annotations: [], prompt: null });
        setInput(externalAttachment.draft);
        setAnnotations([]);
        setSelectedPrompt(null);
        setTaskValues({});
        if (externalAttachment.autoSend) setPendingAutoSend(externalAttachment.draft);
      }
    })();
  }, [draftKey, externalAttachment, handleImageSelect]);

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      const img = prev[index];
      if (img?.preview) URL.revokeObjectURL(img.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  // ── Mission attachment handlers (any file type, cap 10, ≤100 MB each) ──
  /**
   * The single file entry point for picker, paste and drop. It routes by file
   * KIND, not by conversation type: an image stays on the inline path (the
   * model sees it directly), everything else becomes an attachment. A mission
   * composer has no inline-image path, so everything goes to attachments there.
   */
  const handleFileSelect = useCallback(
    (files: FileList | File[]) => {
      const picked = Array.from(files);
      // Skill launches and explicit Mission instructions have no inline-image
      // path: every picked file becomes a sandbox input attachment.
      const images =
        isMissionConversation || selectedSkill || missionInstructionTarget
          ? []
          : picked.filter((f) => f.type.startsWith('image/'));
      const others = picked.filter((f) => !images.includes(f));
      if (images.length > 0) void handleImageSelect(images);
      if (others.length === 0) return;

      const { next, tooLarge, overflow } = isMissionConversation
        ? acceptCloudAttachments(pendingAttachments as never, others)
        : acceptAttachments(pendingAttachments, others);
      if (tooLarge.length > 0) toast(t('cloudAgent.attachmentTooLarge', { name: tooLarge[0].name }), 'error');
      if (overflow > 0) toast(t('cloudAgent.attachmentLimitReached', { count: MAX_ATTACHMENTS }), 'info');
      if (next !== pendingAttachments) setPendingAttachments(next);
    },
    [handleImageSelect, isMissionConversation, missionInstructionTarget, selectedSkill, pendingAttachments, t],
  );

  const handleRemoveAttachment = useCallback((index: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // The two paths stage their bytes differently, so an unsent draft's chips
  // cannot survive a switch between them (a mission key is not a chat_files id).
  useEffect(() => {
    setPendingAttachments([]);
  }, [isMissionConversation]);

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
      if (!e.dataTransfer.files.length) return;
      handleFileSelect(e.dataTransfer.files);
    },
    [handleFileSelect],
  );

  // Translate handler
  const handleTranslate = useCallback(
    async (_messageId: string, targetLang: 'en' | 'zh') => {
      if (!sessionId || effectiveRunActive) return;
      const langLabel = targetLang === 'en' ? 'English' : '中文';
      const prompt = `Please translate the above response to ${langLabel}. Preserve all formatting (markdown, code blocks, lists, links). Only output the translated text.`;
      handleSend(prompt);
    },
    [sessionId, effectiveRunActive, handleSend],
  );

  // Regenerate handler
  const handleRegenerate = useCallback(
    async (messageId: string) => {
      if (!sessionId || effectiveRunActive) return;
      setError(null);
      try {
        const result = await api.regenerateResponse(sessionId, messageId);
        if (result.last_user) {
          setMessages((current) => current.filter((message) => message.id !== messageId));
          sendMessage(sessionId, undefined, undefined, turnEnvironment(), messageId);
        }
      } catch (err: any) {
        setError(err.message || 'Regenerate failed');
      }
    },
    [effectiveRunActive, turnEnvironment, sendMessage, sessionId],
  );

  const handleForkSession = useCallback(
    async (messageId?: string, preserveDraft = false) => {
      if (!sessionId || forkingSession) return;
      setForkingSession(true);
      setError(null);
      try {
        const fork = await api.forkSession(sessionId, messageId);
        if (preserveDraft && input.trim()) {
          sessionDrafts.set(fork.id, { input, annotations: [], prompt: selectedPrompt });
        }
        setSessionId(fork.id);
        if (policy.publishGlobalChatUi) window.history.replaceState(null, '', `#/chat?session=${fork.id}`);
        bumpSessionListVersion();
        toast('Conversation forked. You can continue in your own copy.', 'success');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fork conversation';
        setError(message);
        toast(message, 'error');
      } finally {
        setForkingSession(false);
      }
    },
    [bumpSessionListVersion, forkingSession, input, policy.publishGlobalChatUi, selectedPrompt, sessionId],
  );

  const requestForkSession = useCallback((messageId?: string, preserveDraft = false) => {
    setPendingFork({ messageId, preserveDraft });
  }, []);

  const confirmForkSession = useCallback(() => {
    const request = pendingFork;
    setPendingFork(null);
    if (request) void handleForkSession(request.messageId, request.preserveDraft);
  }, [handleForkSession, pendingFork]);

  const handleWorkbenchConversationModeChange = useCallback((enabled: boolean) => {
    setWorkbenchConversationMode(enabled);
    if (enabled) setTimeout(() => chatInputRef.current?.focus(), 0);
  }, []);

  return (
    <div className="flex flex-col h-full bg-surface-canvas">
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
              {isMissionConversation ? (
                <>
                  <Paperclip size={36} className="mx-auto mb-2 text-primary-fg-strong" />
                  <p className="text-sm font-medium text-primary-fg-strong">{t('cloudAgent.dropFiles')}</p>
                  <p className="text-xs text-primary-500 mt-1">
                    {t('cloudAgent.dropFilesHint', { count: MAX_ATTACHMENTS })}
                  </p>
                </>
              ) : (
                <>
                  <Image size={36} className="mx-auto mb-2 text-primary-fg-strong" />
                  <p className="text-sm font-medium text-primary-fg-strong">{t('chat.dropImages')}</p>
                  <p className="text-xs text-primary-500 mt-1">{t('chat.imageLimit', { count: MAX_IMAGES })}</p>
                </>
              )}
            </div>
          </div>
        )}

        {topSlot}

        {/* Share button moved to the TopBar (next to session tags) — see TopBar. */}

        {/* Shared session banner — shown to non-owners */}
        {sessionId && shareInfo && !isOwner && !shareBannerDismissed && (
          <div className="mx-3 md:mx-4 mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-info-subtle border border-info text-sm text-info animate-fade-in">
            <Share2 size={14} className="flex-shrink-0" />
            <span className="flex-1 min-w-0">
              {t('chat.sharedWithYou', { name: shareInfo.shared_by_nickname })}
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
              !showStreamOverlay &&
              (surface === 'overlay' && suggestions.length > 0 ? (
                <ConversationSuggestions
                  suggestions={suggestions}
                  onSelect={(prompt) => setInput((prev) => (prev ? `${prev}${prompt}` : prompt))}
                />
              ) : (
                (() => {
                  // A new conversation opens onto the personal workbench: this
                  // screen is the user's home page, so it shows their data
                  // first and introduces the assistant only when there is no
                  // data yet.
                  const intro = (
                    <ProfileEmptyState
                      profile={displayProfiles.find((p) => p.id === (sessionId ? sessionProfileId : selectedProfileId))}
                      onCustomize={
                        policy.showWorkbench
                          ? () => {
                              handleWorkbenchConversationModeChange(true);
                              setInput((prev) => prev || t('home.customizePrompt'));
                            }
                          : undefined
                      }
                    />
                  );
                  return policy.showWorkbench ? (
                    <WorkbenchPanel
                      emptyFallback={intro}
                      conversationMode={workbenchConversationMode}
                      onConversationModeChange={handleWorkbenchConversationModeChange}
                    />
                  ) : (
                    intro
                  );
                })()
              ))
            )}

            {!isLoadingSession && workbenchConversationMode && messages.length > 0 && policy.showWorkbench && (
              <div
                data-workbench-live-preview
                className="sticky top-0 z-[5] max-h-[55vh] overflow-y-auto rounded-xl border border-primary-edge bg-surface-canvas/95 p-3 shadow-lg backdrop-blur-sm"
              >
                <WorkbenchPanel conversationMode onConversationModeChange={handleWorkbenchConversationModeChange} />
              </div>
            )}

            {!isLoadingSession &&
              messages.map((msg, idx) => {
                if (groupedMissionOutcomes.groupedOutcomeMessageIds.has(msg.id)) return null;
                const missionOutcome = groupedMissionOutcomes.byOriginMessageId.get(msg.id);
                const isLastUser = msg.role === 'user' && !messages.slice(idx + 1).some((m) => m.role === 'user');
                // Detect if this assistant message has an ask_user tool and the next message is the user's response
                const followUpUserMessage =
                  msg.role === 'assistant' && idx + 1 < messages.length && messages[idx + 1].role === 'user'
                    ? messages[idx + 1].content
                    : undefined;
                const hasFollowUpUserMessage =
                  msg.role === 'assistant' &&
                  msg.pipeline?.some((s) => s.tool === 'ask_user' || (s.output as any)?.type === 'ask_user') &&
                  followUpUserMessage !== undefined;
                const submittedUserMessage = hasFollowUpUserMessage ? followUpUserMessage : undefined;
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
                    inputTokens={msg.input_tokens}
                    outputTokens={msg.output_tokens}
                    cachedTokens={msg.cached_tokens}
                    reasoningTokens={msg.reasoning_tokens}
                    durationMs={msg.duration_ms}
                    model={msg.model}
                    canViewMetrics={currentUser?.role === 'super'}
                    canActOnArtifacts={isOwner}
                    createdAt={msg.created_at}
                    isLastUser={isLastUser}
                    compact={policy.compactMessages}
                    onEdit={isLastUser && !effectiveRunActive && !isMissionConversation ? handleEditMessage : undefined}
                    onTranslate={
                      policy.allowTranslate && !isMissionConversation && msg.role === 'assistant'
                        ? handleTranslate
                        : undefined
                    }
                    onRegenerate={msg.role === 'assistant' && !isMissionConversation ? handleRegenerate : undefined}
                    onQuote={policy.allowQuote && msg.role === 'assistant' ? handleQuote : undefined}
                    isStreaming={effectiveIsStreaming}
                    onAskUserSubmit={
                      msg.role === 'assistant' &&
                      msg.pipeline?.some((s) => s.tool === 'ask_user' || (s.output as any)?.type === 'ask_user')
                        ? isOwner
                          ? handleSend
                          : undefined
                        : undefined
                    }
                    onConfirmAction={msg.role === 'assistant' && isOwner ? handleSend : undefined}
                    hasFollowUpUserMessage={hasFollowUpUserMessage}
                    submittedUserMessage={submittedUserMessage}
                    confirmedActionValue={followUpUserMessage}
                    previousUserMessage={previousUserMsg}
                    missionOutcome={missionOutcome}
                    onFork={
                      policy.showProfileManagement && sessionId && sessionChannel === 'web'
                        ? requestForkSession
                        : undefined
                    }
                  />
                );
              })}

            {!isLoadingSession && showStreamOverlay && (
              <StreamingMessageBubble
                text={effectiveStreamText}
                reasoning={effectiveStreamReasoning}
                toolCalls={effectiveStreamToolCalls}
                isStreaming={effectiveIsStreaming}
              />
            )}

            {/* The Dock owns compact operational progress. Readable sandbox
                assistant updates temporarily live here while the run is active;
                the durable outcome message replaces them after settlement. */}
            {!isLoadingSession && <MissionProgressMessages events={mission.events} active={!!mission.activeRun} />}

            <div ref={messagesEndRef} />

            {/* Jump-to-latest — sticks to the bottom of the scroll viewport */}
            {/* Only ever about the transcript. The empty state can scroll too —
                it holds the workbench — but "jump to latest" over a dashboard
                with no messages in it is nonsense. */}
            {showScrollButton && messages.length > 0 && (
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
          <div className="flex items-center gap-1.5 border-t border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">
            <AlertTriangle size={13} className="flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Input — read-only for workflow node sessions (engine-produced audit
            records) and for non-owners of shared sessions */}
        {sessionId && sessionChannel === 'workflow' ? (
          <WorkflowNodeSessionBar parentSessionId={parentSessionId} />
        ) : sessionId && !isOwner ? (
          <ChatInput
            input={input}
            setInput={setInput}
            isStreaming={false}
            pendingImages={[]}
            onSend={() => requestForkSession(undefined, true)}
            onStop={() => {}}
            onImageSelect={() => {}}
            onRemoveImage={() => {}}
            attachmentsDisabled
            hideSendButton
            placeholder={t('chat.sharedConversationPlaceholder')}
            aboveSlot={
              <div className="mb-2 flex items-center justify-center gap-2 text-xs text-fg-muted">
                <Eye size={13} />
                <span>{t('chat.sharedBy', { name: shareInfo?.shared_by_nickname ?? '' })}</span>
              </div>
            }
            rightSlot={
              <>
                <ProfileSelector
                  profiles={displayProfiles}
                  selectedProfileId={sessionProfileId}
                  onSelectProfile={handleProfileChange}
                  readonly
                />
                <Button
                  size="sm"
                  onClick={() => requestForkSession(undefined, true)}
                  disabled={forkingSession}
                  className="flex-shrink-0"
                >
                  <GitFork size={13} className="mr-1.5" />
                  {t(forkingSession ? 'chat.forking' : 'chat.fork')}
                </Button>
              </>
            }
          />
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
            sendWaiting={imageUploadWaiting}
            autoFocus={typeof window !== 'undefined' && window.innerWidth >= 768}
            sendDisabled={
              effectiveIsStopping ||
              attachmentsUploading ||
              (isMissionConversation && (!!mission.activeRun || (!!sessionId && !mission.loaded)))
            }
            // Missions have no inline-image path; every other conversation keeps
            // images inline AND accepts files.
            attachmentsDisabled={isMissionConversation}
            pendingAttachments={pendingAttachments}
            onAttachmentSelect={handleFileSelect}
            onRemoveAttachment={handleRemoveAttachment}
            maxAttachments={MAX_ATTACHMENTS}
            inputRef={chatInputRef}
            placeholder={
              missionInstructionTarget
                ? t('cloudAgent.dockFollowUpPlaceholder')
                : workbenchConversationMode
                  ? t('home.chatEditPlaceholder')
                  : undefined
            }
            aboveSlot={
              sessionId ? (
                <TaskDock
                  sessionId={sessionId}
                  mission={mission}
                  workflowEnabled={currentUser?.role === 'super'}
                  onTaskSettled={reloadSettledTranscript}
                  onAddMissionInstruction={(run) => {
                    setSelectedSkill(null);
                    setMissionInstructionTarget(run);
                    setError(null);
                    requestAnimationFrame(() => chatInputRef.current?.focus());
                  }}
                />
              ) : null
            }
            slashPrompts={slashPrompts}
            slashSkills={slashSkills}
            missionAvailability={canLaunchMissions ? missionAvailability : undefined}
            selectedPrompt={selectedPrompt}
            selectedSkill={selectedSkill}
            missionInstruction={!!missionInstructionTarget}
            taskValues={taskValues}
            onTaskValueChange={(key, value) => setTaskValues((prev) => ({ ...prev, [key]: value }))}
            onSelectPrompt={(prompt) => {
              setSelectedPrompt(prompt);
              // Values belong to the task that was attached; carrying them
              // across a swap would silently fill a different task's fields.
              setTaskValues({});
            }}
            onRemovePrompt={() => {
              setSelectedPrompt(null);
              setTaskValues({});
            }}
            onSelectSkill={(skill) => {
              setMissionInstructionTarget(null);
              setSelectedSkill(skill);
            }}
            onRemoveSkill={() => {
              setSelectedSkill(null);
              // A failed new-chat Mission may already have staged user-owned
              // blob keys. Ordinary Chat needs session-owned chat_file ids, so
              // keep the visible files but drop only those incompatible refs;
              // the next send re-uploads them through the correct endpoint.
              if (!sessionId) {
                setPendingAttachments((prev) =>
                  prev.map((attachment) =>
                    attachment.uploaded && 'key' in attachment.uploaded
                      ? { file: attachment.file, uploading: false }
                      : attachment,
                  ),
                );
              }
            }}
            onRemoveMissionInstruction={() => setMissionInstructionTarget(null)}
            profiles={displayProfiles}
            selectedProfileId={sessionId ? sessionProfileId : selectedProfileId}
            mentionEnabled={!sessionId && displayProfiles.length > 1}
            onMentionProfile={handleMentionProfile}
            profileChip={
              !sessionId && mentionedProfileId
                ? (displayProfiles.find((p) => p.id === mentionedProfileId) ?? null)
                : null
            }
            onRemoveProfileChip={handleRemoveProfileChip}
            annotations={annotations}
            onUpdateAnnotation={(id, note) =>
              setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, note } : a)))
            }
            onDeleteAnnotation={(id) => setAnnotations((prev) => prev.filter((a) => a.id !== id))}
            onClearAnnotations={() => setAnnotations([])}
            rightSlot={
              <>
                <ProfileSelector
                  profiles={displayProfiles}
                  selectedProfileId={sessionId ? sessionProfileId : selectedProfileId}
                  onSelectProfile={handleProfileChange}
                  readonly={!!sessionId}
                  onFork={policy.showProfileManagement && !sessionId ? handleFork : undefined}
                />
                {activeProfile?.id === DEFAULT_AGENT_ID && (
                  <ModelSelector
                    models={models}
                    selectedModelId={selectedModelId}
                    onSelect={handleModelChange}
                    disabled={effectiveRunActive}
                  />
                )}
              </>
            }
          />
        )}
      </div>

      {/* Share Dialog */}
      {policy.showShare && sessionId && (
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

      <ForkConfirmationDialog
        open={pendingFork !== null}
        fromReply={pendingFork?.messageId !== undefined}
        onClose={() => setPendingFork(null)}
        onConfirm={confirmForkSession}
      />

      {/* Fork Profile Editor */}
      {policy.showProfileManagement && (
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
      )}
    </div>
  );
}

function ConversationSuggestions({
  suggestions,
  onSelect,
}: {
  suggestions: NonNullable<ConversationPaneProps['suggestions']>;
  onSelect: (message: string) => void;
}) {
  const t = useT();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-2 py-6">
      <div className="mb-2 text-center">
        <p className="text-sm font-medium text-fg-secondary">{t('chat.pageHelpTitle')}</p>
        <p className="mt-1 text-xs text-fg-faint">{t('chat.pageHelpDesc')}</p>
      </div>
      {suggestions.map((suggestion) => {
        const Icon = suggestion.icon;
        return (
          <button
            key={`${suggestion.label}:${suggestion.message}`}
            onClick={() => onSelect(suggestion.message)}
            className="flex w-full items-center gap-2 rounded-lg border border-edge bg-surface-card px-3 py-2 text-left text-sm text-fg-secondary transition-colors hover:border-primary-300 hover:bg-primary-subtle/30"
          >
            {Icon && <Icon size={14} className="flex-shrink-0 text-fg-faint" />}
            <span>{suggestion.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Profile Empty State ───────────────────────────────

/**
 * What a new conversation shows when the user has no workbench cards yet: who
 * they are talking to, and one quiet way to build a home page.
 *
 * The capability list ("Try asking") that used to fill the right half is gone on
 * purpose (spec D16). The first thing this screen owes the user is their own
 * data; a catalogue of what the assistant can do is neither that nor something
 * anyone reads twice. Profile capabilities were removed outright afterwards —
 * YAML, type, column, editor section and all.
 */
function ProfileEmptyState({ profile, onCustomize }: { profile?: api.Profile; onCustomize?: () => void }) {
  const t = useT();
  const localized = useLocalized();
  const description = localized(profile?.description_i18n, profile?.description ?? '');

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-3 px-2 py-10 text-center md:py-16">
      <SproutyAvatar
        {...profileToSprouty(profile || ({ id: 'team', name: '', tools: [] } as any))}
        state="idle"
        size="xl"
        animate
      />
      <div>
        <h3 className="text-lg font-medium text-fg-secondary">
          {localized(profile?.name_i18n, profile?.name ?? '') || t('chat.startConversation')}
        </h3>
        <p className="mt-1 text-sm text-fg-faint leading-snug">{description || t('chat.defaultDescription')}</p>
      </div>
      {onCustomize && (
        <button
          type="button"
          onClick={onCustomize}
          className="mt-1 text-xs text-fg-faint underline decoration-dotted underline-offset-4 transition-colors hover:text-fg-secondary"
        >
          {t('home.customizeEntry')}
        </button>
      )}
    </div>
  );
}

/**
 * Composer replacement for workflow node/reviewer sessions: these transcripts
 * are produced by the engine and read as an audit trail, so typing into them
 * would corrupt the record. The back link returns to the orchestrating chat.
 */
function WorkflowNodeSessionBar({ parentSessionId }: { parentSessionId: string | null }) {
  const t = useT();
  return (
    <div className="flex-shrink-0 border-t border-edge bg-surface-muted px-3 py-3 md:px-4">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-center gap-2 py-1 text-sm text-fg-muted">
        <Eye size={14} />
        <span>{t('workflow.nodeSessionReadOnly')}</span>
        {parentSessionId && (
          <button
            onClick={() => {
              window.location.hash = `#/chat?session=${parentSessionId}`;
            }}
            className="rounded-md border border-edge bg-surface-raised px-2 py-1 text-xs text-fg-secondary transition-colors hover:bg-surface-muted hover:text-fg"
          >
            ← {t('workflow.backToWorkflow')}
          </button>
        )}
      </div>
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
