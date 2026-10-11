/**
 * The conversation column of the Bots page: header, transcript, background
 * task dock and composer for one conversation. State comes from
 * `useBotConversation` (owned by the page, which also hosts the info and
 * computer panes beside this column).
 *
 * Not ConversationPane (spec D17): that controller is single-agent — its
 * messages have no author, its stream has no speaker, and its drafts, dock
 * and side pane are bound to one Agent. The renderers underneath are shared.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isSproutyBot, type BotConversationSummary, type BotRequestView, type BotView } from '@greenhouse/types/bots';
import { EmptyState, Skeleton, Button, toast } from '../ui';
import { AlertTriangle, Archive, MessageCircle, Paperclip, Plus } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { copyForCode, isBotsApiError, updateTaskChat } from '../../lib/api/bots';
import { useProfileStore, useUIStore } from '../../stores';
import { MAX_ATTACHMENTS } from '../conversation/attachments';
import { ModelSelector } from '../chat/model-selector';
import { BotsBareHeader, BotsMobileNavButton, ConversationHeader, useStatusLine } from './conversation-header';
import { BotTranscript } from './bot-transcript';
import { useBotsStore } from './bots-store';
import { BotsComposer, type BotsComposerHandle } from './bots-composer';
import { BotTaskDock, useBotTasks } from './bot-task-dock';
import { speakingSegment } from './transcript';
import { takeFirstSend } from './first-send';
import type { BotConversationController } from './use-bot-conversation';
import type { BotLookup } from './transcript-rows';
import type { ComputerPhase, ComputerStatusState } from './computer-phase';

/** The owner and up to five guests (the API's cap per conversation). */
const MAX_MEMBERS = 6;

/** Drafts outlive switching conversations (module scope, like Chat's). */
const drafts = new Map<string, string>();

/**
 * 409 codes the API answers a message with when nobody in the conversation
 * can reply any more — its Bot was archived (`bot_archived`), or it is a
 * retired group chat (`group_closed`, kept as a record). Nothing was persisted.
 * (`BotConversationReadOnlyCode` in @greenhouse/types/bots.)
 */
const READ_ONLY_CODES: ReadonlySet<string> = new Set(['bot_archived', 'group_closed']);

export function isReadOnlySendError(err: unknown): boolean {
  return isBotsApiError(err) && err.status === 409 && err.code !== null && READ_ONLY_CODES.has(err.code);
}

/** Why "edit" / "answer again" was refused (POST …/rewind), in the member's words. */
const REWIND_COPY: Partial<Record<string, TranslationKey>> = {
  busy: 'bots.rewind.busy',
  not_last: 'bots.rewind.notLast',
  not_found: 'bots.rewind.notFound',
  requests_pending: 'bots.rewind.requestsPending',
  not_task_chat: 'bots.rewind.notTaskChat',
};

export interface ConversationViewProps {
  sessionId: string;
  controller: BotConversationController;
  /** Active member Bots, by position — who can be @-mentioned and reply. */
  members: BotView[];
  /** A DM's Bot from the full directory — present (and maybe archived) once the Bot list is in. */
  owner: BotView | undefined;
  lookup: BotLookup;
  title: string;
  /** Where the Bot list stands: rendering before it lands would name every Bot "Deleted Bot". */
  botsState: 'loading' | 'ready' | 'error';
  onRetryBots: () => void;
  /** Nobody here can reply any more (the DM's Bot was archived). A group chat is always read-only. */
  readOnly: boolean;
  /** Something changed that makes the conversation read-only: re-read the Bots and the conversation. */
  onReadOnly: () => void;
  vaultAvailable: boolean;
  computerPhase: ComputerPhase | null;
  /** The page's one computer status — a human-check card embeds the screen and takes over through it. */
  computer?: ComputerStatusState;
  activePane: 'info' | 'computer' | null;
  onPane: (pane: 'info' | 'computer' | null) => void;
  onInvite: () => void;
  onNewBot: () => void;
  onOpenProfile: (botId: string) => void;
}

export function ConversationView(props: ConversationViewProps) {
  const { sessionId, controller, lookup, botsState, onRetryBots, onReadOnly } = props;
  const t = useT();
  const { conversation, managed, streaming } = controller;
  // The API just refused a message as read-only: swap the composer for the
  // notice now, not after the Bot list re-read lands (or if it fails). Cleared
  // when the conversation changes or its members do.
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  const memberKey = conversation?.members.map((member) => member.bot_id).join(',') ?? '';
  useEffect(() => setRefusedFor(null), [sessionId, memberKey]);
  // Group chats were retired: an old one is a record, whatever the host worked out.
  const readOnly = props.readOnly || refusedFor === sessionId || conversation?.kind === 'group';
  const [draft, setDraftState] = useState(() => drafts.get(sessionId) ?? '');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const { tasks, refresh: refreshTasks } = useBotTasks(sessionId);

  // A separate chat runs on the model chosen for it (spec 20261011-agent-first-class D22); a DM
  // always answers on its Agent's own. The picker shows the choice made here at once, before the
  // PATCH lands.
  const isTaskChat = conversation?.kind === 'task';
  const models = useProfileStore((state) => state.models);
  const fetchProfiles = useProfileStore((state) => state.fetchProfiles);
  useEffect(() => {
    if (isTaskChat) void fetchProfiles();
  }, [fetchProfiles, isTaskChat]);
  const [modelPick, setModelPick] = useState<{ sessionId: string; modelId: string } | null>(null);
  const chatModel = isTaskChat
    ? ((modelPick?.sessionId === sessionId ? modelPick.modelId : null) ??
      conversation?.model_id ??
      props.owner?.model_id ??
      null)
    : null;
  // Only a model the catalog still offers is sent; otherwise the chat falls back to the Agent's.
  const sendModel = chatModel && models.some((model) => model.id === chatModel) ? chatModel : undefined;

  useEffect(() => setDraftState(drafts.get(sessionId) ?? ''), [sessionId]);
  const setDraft = useCallback(
    (value: string) => {
      drafts.set(sessionId, value);
      setDraftState(value);
    },
    [sessionId],
  );

  const segments = managed?.botSegments ?? [];
  const speaking = streaming ? speakingSegment(segments) : null;
  const pendingRequests = useMemo(
    () => [...controller.requests.values()].filter((request) => request.status === 'pending'),
    [controller.requests],
  );

  /**
   * Every send path — the composer, Retry / Continue / Ask again, an ask_user
   * form, a confirm block — explains a failure the same way. A conversation
   * that just became read-only says so (and the column swaps the composer for
   * the notice at once); anything else reads as "Could not send".
   */
  const reportSendFailure = useCallback(
    (err: unknown) => {
      if (isReadOnlySendError(err)) {
        // Read-only for good: an archived Bot's DM (a new Bot is the way on) or a retired group chat.
        toast(
          t(isBotsApiError(err, 'group_closed') ? 'bots.readOnly.groupClosedTitle' : 'bots.readOnly.sendRefused'),
          'info',
        );
        setRefusedFor(sessionId);
        onReadOnly();
        return;
      }
      toast(t('bots.composer.sendFailed', { reason: err instanceof Error ? err.message : String(err) }), 'error');
    },
    [onReadOnly, sessionId, t],
  );

  /** Rejects (after reporting) when nothing was delivered, so a form can re-arm and the composer keep its draft. */
  const send = useCallback(
    async (text: string, images: Array<{ id: string; url: string }>, mentions: string[]) => {
      try {
        await controller.send(text, { images, mentions, ...(sendModel ? { model: sendModel } : {}) });
      } catch (err) {
        reportSendFailure(err);
        throw err;
      }
    },
    [controller, reportSendFailure, sendModel],
  );

  /**
   * An answer from a card in a reply (an ask_user form, a confirm block) — like Chat, not while a
   * reply is still under way: the form keeps the answers and can be sent once it is done.
   */
  const sendFromCard = useCallback(
    (text: string) => {
      if (streaming) {
        toast(t('bots.composer.waitForReply'), 'info');
        return Promise.reject(new Error('busy'));
      }
      return send(text, [], []);
    },
    [send, streaming, t],
  );

  // The first message of a chat started on the new-chat page goes out from here, through the same
  // send path as the composer (its pending bubble, its failure notice); a failure gives it back as a draft.
  const loadedSession = controller.state === 'ready' ? (conversation?.session_id ?? null) : null;
  useEffect(() => {
    if (loadedSession !== sessionId) return;
    const first = takeFirstSend(sessionId);
    if (!first) return;
    send(first.content, first.images, []).catch(() => setDraft(first.draft));
  }, [loadedSession, send, sessionId, setDraft]);

  const changeModel = useCallback(
    (modelId: string) => {
      setModelPick({ sessionId, modelId });
      updateTaskChat(sessionId, { model_id: modelId })
        .then(({ conversation: next }) => controller.setConversation(next))
        .catch(() => {
          setModelPick(null);
          toast(t('bots.composer.modelFailed'), 'error');
        });
    },
    [controller, sessionId, t],
  );

  const rename = useCallback(
    async (title: string) => {
      try {
        const { conversation: next } = await updateTaskChat(sessionId, { title });
        controller.setConversation(next);
        // The chats list names it too.
        useUIStore.getState().bumpSessionListVersion();
      } catch (err) {
        toast(t('bots.header.renameFailed'), 'error');
        throw err;
      }
    },
    [controller, sessionId, t],
  );

  /** "Edit" / "answer again" refused: a read-only chat says so like a send; anything else in a line. */
  const reportRewindFailure = useCallback(
    (err: unknown) => {
      if (isReadOnlySendError(err)) {
        reportSendFailure(err);
        return;
      }
      const key = isBotsApiError(err) ? copyForCode(REWIND_COPY, err.code) : undefined;
      toast(
        key ? t(key) : t('bots.rewind.failed', { reason: err instanceof Error ? err.message : String(err) }),
        'error',
      );
      // The transcript may have moved on (another tab, a message that is no longer last).
      void controller.reload();
    },
    [controller, reportSendFailure, t],
  );
  const editLast = useCallback(
    (messageId: string, content: string) => void controller.rewind(messageId, content).catch(reportRewindFailure),
    [controller, reportRewindFailure],
  );
  const regenerateLast = useCallback(
    (messageId: string) => void controller.rewind(messageId).catch(reportRewindFailure),
    [controller, reportRewindFailure],
  );

  /** One click on "Retry" / "Continue" / "Ask again" is an honest new member message. */
  const address = useCallback(
    (botId: string | null, kind: 'retry' | 'continue') => {
      const bot = botId ? lookup(botId) : undefined;
      const line = t(kind === 'retry' ? 'bots.transcript.retryMessage' : 'bots.transcript.continueMessage');
      const text = bot ? `@${bot.name} ${line}` : line;
      // Already reported by `send`; nothing else to restore for a one-click line.
      send(text, [], bot ? [bot.id] : []).catch(() => {});
    },
    [lookup, send, t],
  );

  const prefill = useCallback(
    (text: string) => {
      setDraft(text);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [setDraft],
  );

  if (botsState === 'error') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <BotsBareHeader title={t('bots.title')} />
        <div className="flex min-h-0 flex-1 items-center justify-center" data-testid="bots-conversation-error">
          <EmptyState
            icon={AlertTriangle}
            tone="danger"
            variant="page"
            title={t('bots.loadFailed')}
            action={
              <Button size="sm" onClick={onRetryBots}>
                {t('bots.retry')}
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  // The Bot list is part of "loaded": until it lands, an id we have not heard
  // of yet would render as "Deleted Bot" in the title, the intro and every speaker.
  if (controller.state === 'loading' || (controller.state === 'ready' && (!conversation || botsState === 'loading'))) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" aria-busy="true" data-testid="bots-conversation-loading">
        <div className="flex min-h-12 items-center gap-2 border-b border-edge px-2 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] md:px-4 md:py-1.5">
          <BotsMobileNavButton />
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-3 w-40" />
        </div>
        <div className="mx-auto w-full max-w-5xl space-y-4 px-6 py-6">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="ml-auto h-10 w-1/3 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (controller.state === 'not_found' || controller.state === 'error' || !conversation) {
    const notFound = controller.state === 'not_found';
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <BotsBareHeader title={t('bots.title')} />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={notFound ? MessageCircle : AlertTriangle}
            tone={notFound ? 'neutral' : 'danger'}
            variant="page"
            title={notFound ? t('bots.notFoundTitle') : t('bots.loadFailed')}
            description={notFound ? t('bots.notFoundDescription') : (controller.error ?? undefined)}
            action={
              notFound ? (
                <Button size="sm" onClick={() => (window.location.hash = '#/bots')}>
                  {t('bots.backToBots')}
                </Button>
              ) : (
                <Button size="sm" onClick={() => void controller.reload()}>
                  {t('bots.retry')}
                </Button>
              )
            }
          />
        </div>
      </div>
    );
  }

  return (
    <ConversationColumn
      {...props}
      readOnly={readOnly}
      conversation={conversation}
      speaking={speaking}
      pendingRequests={pendingRequests}
      draft={draft}
      setDraft={setDraft}
      inputRef={inputRef}
      send={send}
      address={address}
      prefill={prefill}
      tasks={tasks}
      refreshTasks={refreshTasks}
      sendFromCard={sendFromCard}
      taskChat={
        isTaskChat
          ? {
              models,
              model: chatModel,
              onModel: changeModel,
              onRename: rename,
              onEditLast: editLast,
              onRegenerateLast: regenerateLast,
            }
          : null
      }
    />
  );
}

/** What a separate chat adds to the column: its model, its title, edit / answer again. */
interface TaskChatControls {
  models: ReturnType<typeof useProfileStore.getState>['models'];
  model: string | null;
  onModel: (modelId: string) => void;
  onRename: (title: string) => Promise<void>;
  onEditLast: (messageId: string, content: string) => void;
  onRegenerateLast: (messageId: string) => void;
}

function ConversationColumn({
  sessionId,
  controller,
  conversation,
  members,
  owner,
  lookup,
  title,
  readOnly,
  vaultAvailable,
  computerPhase,
  computer,
  activePane,
  onPane,
  onInvite,
  onNewBot,
  onOpenProfile,
  speaking,
  pendingRequests,
  draft,
  setDraft,
  inputRef,
  send,
  address,
  prefill,
  tasks,
  refreshTasks,
  sendFromCard,
  taskChat,
}: ConversationViewProps & {
  conversation: NonNullable<BotConversationController['conversation']>;
  speaking: ReturnType<typeof speakingSegment>;
  pendingRequests: BotRequestView[];
  draft: string;
  setDraft: (value: string) => void;
  inputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  send: (text: string, images: Array<{ id: string; url: string }>, mentions: string[]) => Promise<void>;
  address: (botId: string | null, kind: 'retry' | 'continue') => void;
  prefill: (text: string) => void;
  tasks: ReturnType<typeof useBotTasks>['tasks'];
  refreshTasks: () => Promise<void>;
  sendFromCard: (text: string) => Promise<void>;
  taskChat: TaskChatControls | null;
}) {
  const t = useT();
  const status = useStatusLine({ conversation, members, speaking, pendingRequests, computerPhase, readOnly });
  // A DM and a separate chat belong to one Agent; only a retired group had a roster.
  const single = conversation.kind !== 'group';
  // Guests join a live DM only: an archived Bot's DM has nobody to host them, and a group chat is a record.
  const canInvite = !readOnly && conversation.members.length < MAX_MEMBERS;
  const segments = controller.managed?.botSegments ?? [];
  const liveRequests = controller.managed?.botRequests ?? [];
  const placeholder = owner
    ? t('bots.composer.placeholderDm', { name: owner.name })
    : t('bots.composer.placeholderShort');
  // A retired group's intro shows the roster it had (the active ones).
  const introBots = single ? (owner ? [owner] : []) : members;

  // ── Drop files anywhere on the conversation → the composer's attachments ──
  const composerRef = useRef<BotsComposerHandle>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const acceptsDrop = !readOnly;
  const onDragEnter = (event: React.DragEvent) => {
    if (!acceptsDrop || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (event: React.DragEvent) => {
    if (!acceptsDrop) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDragOver = (event: React.DragEvent) => {
    // Without this the browser would open the dropped file in place of the app.
    if (acceptsDrop && event.dataTransfer.types.includes('Files')) event.preventDefault();
  };
  const onDrop = (event: React.DragEvent) => {
    if (!acceptsDrop) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer.files.length > 0) composerRef.current?.addFiles(event.dataTransfer.files);
  };

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="bots-conversation"
      data-session-id={sessionId}
      data-read-only={readOnly || undefined}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {dragging && (
        <div
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-primary-400 bg-primary-subtle/80"
          data-testid="bots-drop-overlay"
        >
          <div className="text-center">
            <Paperclip size={32} className="mx-auto mb-2 text-primary-fg-strong" aria-hidden="true" />
            <p className="text-sm font-medium text-primary-fg-strong">{t('cloudAgent.dropFiles')}</p>
            <p className="mt-1 text-xs text-primary-500">{t('cloudAgent.dropFilesHint', { count: MAX_ATTACHMENTS })}</p>
          </div>
        </div>
      )}
      <ConversationHeader
        title={title}
        conversation={conversation}
        owner={owner}
        members={members}
        speakingId={speaking?.botId ?? null}
        status={status}
        computerPhase={computerPhase}
        activePane={activePane}
        canInvite={canInvite}
        onInvite={onInvite}
        onOpenComputer={() => onPane(activePane === 'computer' ? null : 'computer')}
        onOpenInfo={() => onPane(activePane === 'info' ? null : 'info')}
        onOpenProfile={onOpenProfile}
        onRename={taskChat && !readOnly ? taskChat.onRename : undefined}
      />
      <BotTranscript
        sessionId={sessionId}
        kind={conversation.kind}
        title={title}
        ownerBotId={conversation.owner_bot_id}
        members={introBots}
        lookup={lookup}
        messages={controller.messages}
        hasMore={controller.hasMore}
        loadingEarlier={controller.loadingEarlier}
        onLoadEarlier={() => void controller.loadEarlier()}
        segments={segments}
        liveRequests={liveRequests}
        pending={controller.pending}
        requests={controller.requests}
        memoryStates={controller.memoryStates}
        busy={controller.streaming}
        interrupting={controller.interrupting}
        onHandleNow={(clientId) => void controller.handleNow(clientId)}
        computer={computer}
        computerNotice={
          computerPhase?.kind === 'starting' ? 'starting' : computerPhase?.kind === 'queued' ? 'queued' : null
        }
        runError={controller.runError}
        onDismissRunError={controller.dismissRunError}
        vaultAvailable={vaultAvailable}
        onRequestSettled={controller.applyRequest}
        onStale={() => void controller.reload()}
        onOpenComputer={() => onPane('computer')}
        onViewSummary={() => onPane('info')}
        onAddress={address}
        onSendText={sendFromCard}
        onStarter={prefill}
        onOpenProfile={onOpenProfile}
        readOnly={readOnly}
        onEditLast={taskChat?.onEditLast}
        onRegenerateLast={taskChat?.onRegenerateLast}
      />
      {!readOnly && owner && isSproutyBot(owner) && owner.name === 'Sprouty' && owner.current_version === 1 && (
        <SproutyNamingNudge bot={owner} onOpenProfile={onOpenProfile} />
      )}
      {readOnly ? (
        <ReadOnlyNotice kind={conversation.kind} name={owner?.name ?? null} onNewBot={onNewBot} />
      ) : (
        <BotsComposer
          // Remount per conversation: attachments belong to the draft they were added to.
          key={sessionId}
          ref={composerRef}
          sessionId={sessionId}
          members={members}
          placeholder={placeholder}
          busy={controller.streaming}
          stopPhase={controller.stopPhase}
          input={draft}
          setInput={setDraft}
          onSend={send}
          onStop={controller.stop}
          onInvite={onInvite}
          canInvite={canInvite}
          inputRef={inputRef}
          aboveSlot={<BotTaskDock tasks={tasks} lookup={lookup} onChanged={() => void refreshTasks()} />}
          toolbarSlot={
            taskChat ? (
              <ModelSelector models={taskChat.models} selectedModelId={taskChat.model} onSelect={taskChat.onModel} />
            ) : null
          }
        />
      )}
    </div>
  );
}

/**
 * In place of the composer when nobody here can reply: the history stays
 * readable. An archived Bot's DM offers the way forward in one click (a new
 * Bot) — there is no "restore": its name may already belong to a newer Bot. A
 * retired group chat is a record: it says so, and its Bots carry on in their
 * own DMs.
 */
function ReadOnlyNotice({
  kind,
  name,
  onNewBot,
}: {
  kind: BotConversationSummary['kind'];
  name: string | null;
  onNewBot: () => void;
}) {
  const t = useT();
  // A DM or a separate chat whose Agent was archived: the way on is a new Agent.
  const direct = kind !== 'group';
  return (
    <div
      className="flex-shrink-0 border-t border-edge bg-surface-raised px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 md:px-6"
      data-testid="bots-read-only"
      role="status"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-3 rounded-xl border border-edge bg-surface-sunken px-3 py-2.5">
        <Archive size={16} className="flex-shrink-0 text-fg-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">
            {direct
              ? name
                ? t('bots.readOnly.dmTitle', { name })
                : t('bots.readOnly.dmTitleUnknown')
              : t('bots.readOnly.groupClosedTitle')}
          </p>
          <p className="text-xs text-fg-muted">
            {direct ? t('bots.readOnly.dmDescription') : t('bots.readOnly.groupClosedDescription')}
          </p>
        </div>
        {direct && (
          <Button size="sm" onClick={onNewBot} data-testid="bots-read-only-new-bot">
            <Plus size={14} className="mr-1" />
            {t('bots.sidebar.newBot')}
          </Button>
        )}
      </div>
    </div>
  );
}

const NAMING_DISMISSED_KEY = 'greenhouse_bots_sprouty_named';

/**
 * First-run naming nudge (spec 20261007 phase 4, OpenClaw's "birth sequence"
 * trimmed to one card): the built-in main Bot still carries its template name
 * and has never been edited. Rename it (opens the edit dialog) or keep it;
 * either way the nudge is gone for this browser.
 */
function SproutyNamingNudge({ bot, onOpenProfile }: { bot: BotView; onOpenProfile: (botId: string) => void }) {
  const t = useT();
  const openProfile = useBotsStore((state) => state.openProfile);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return (localStorage.getItem(NAMING_DISMISSED_KEY) ?? '').split(',').includes(bot.id);
    } catch {
      return false;
    }
  });
  const dismiss = () => {
    setDismissed(true);
    try {
      const seen = (localStorage.getItem(NAMING_DISMISSED_KEY) ?? '').split(',').filter(Boolean);
      localStorage.setItem(NAMING_DISMISSED_KEY, [...new Set([...seen, bot.id])].join(','));
    } catch {
      /* private mode: the nudge simply returns next time */
    }
  };
  if (dismissed) return null;
  void onOpenProfile;
  return (
    <div
      className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary-edge bg-primary-subtle px-3 py-2 text-xs text-fg"
      data-testid="bots-naming-nudge"
    >
      <span className="min-w-0 flex-1">{t('bots.naming.prompt', { name: bot.name })}</span>
      <Button size="sm" variant="ghost" onClick={dismiss}>
        {t('bots.naming.keep', { name: bot.name })}
      </Button>
      <Button
        size="sm"
        onClick={() => {
          dismiss();
          openProfile(bot.id, { edit: true });
        }}
      >
        {t('bots.naming.rename')}
      </Button>
    </div>
  );
}
