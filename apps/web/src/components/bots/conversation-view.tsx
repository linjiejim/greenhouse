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
import { isSproutyBot, type BotRequestView, type BotView } from '@greenhouse/types/bots';
import { EmptyState, Skeleton, Button, toast } from '../ui';
import { AlertTriangle, Archive, MessageCircle, Paperclip, Plus, UserPlus } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { isBotsApiError } from '../../lib/api/bots';
import { MAX_ATTACHMENTS } from '../conversation/attachments';
import { BotsBareHeader, BotsMobileNavButton, ConversationHeader, useStatusLine } from './conversation-header';
import { BotTranscript } from './bot-transcript';
import { useBotsStore } from './bots-store';
import { BotsComposer, type BotsComposerHandle } from './bots-composer';
import { BotTaskDock, useBotTasks } from './bot-task-dock';
import { speakingSegment } from './transcript';
import type { BotConversationController } from './use-bot-conversation';
import type { BotLookup } from './transcript-rows';
import type { ComputerPhase, ComputerStatusState } from './computer-phase';

const MAX_MEMBERS = 6;

/** Drafts outlive switching conversations (module scope, like Chat's). */
const drafts = new Map<string, string>();

/**
 * 409 codes the API answers a message with when nobody in the conversation
 * can reply any more (its Bot was archived). Nothing was persisted.
 */
const READ_ONLY_CODES = new Set(['bot_archived', 'no_active_members', 'conversation_read_only']);

export function isReadOnlySendError(err: unknown): boolean {
  return isBotsApiError(err) && err.status === 409 && err.code !== null && READ_ONLY_CODES.has(err.code);
}

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
  /** Nobody here can reply any more (the DM's Bot, or every Bot of a group, was archived). */
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
  const { sessionId, controller, lookup, botsState, onRetryBots, onReadOnly, onInvite } = props;
  const t = useT();
  const { conversation, managed, streaming } = controller;
  // The API just refused a message as read-only: swap the composer for the
  // notice now, not after the Bot list re-read lands (or if it fails). Cleared
  // when the conversation changes or someone joins it (an invite answers
  // `no_active_members`).
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  const memberKey = conversation?.members.map((member) => member.bot_id).join(',') ?? '';
  useEffect(() => setRefusedFor(null), [sessionId, memberKey]);
  const readOnly = props.readOnly || refusedFor === sessionId;
  const [draft, setDraftState] = useState(() => drafts.get(sessionId) ?? '');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const { tasks, refresh: refreshTasks } = useBotTasks(sessionId);

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
   * the notice once the re-read lands); anything else reads as "Could not send".
   */
  const canInviteMore = (conversation?.members.length ?? 0) < MAX_MEMBERS;
  const reportSendFailure = useCallback(
    (err: unknown) => {
      if (isReadOnlySendError(err)) {
        // A group with no active Bot can be fixed right here — invite one; an
        // archived Bot's DM is read-only for good (a new Bot is the way on).
        const invite = isBotsApiError(err, 'no_active_members') && canInviteMore;
        toast(t(invite ? 'bots.readOnly.inviteToReply' : 'bots.readOnly.sendRefused'), 'info');
        setRefusedFor(sessionId);
        onReadOnly();
        if (invite) onInvite();
        return;
      }
      toast(t('bots.composer.sendFailed', { reason: err instanceof Error ? err.message : String(err) }), 'error');
    },
    [canInviteMore, onInvite, onReadOnly, sessionId, t],
  );

  /** Rejects (after reporting) when nothing was delivered, so a form can re-arm and the composer keep its draft. */
  const send = useCallback(
    async (text: string, images: Array<{ id: string; url: string }>, mentions: string[]) => {
      try {
        await controller.send(text, { images, mentions });
      } catch (err) {
        reportSendFailure(err);
        throw err;
      }
    },
    [controller, reportSendFailure],
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
    />
  );
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
}) {
  const t = useT();
  const status = useStatusLine({ conversation, members, speaking, pendingRequests, computerPhase, readOnly });
  const isDirect = conversation.kind === 'direct';
  // A read-only DM takes no guests: its Bot is gone, so nobody would lead them.
  const canInvite = conversation.members.length < MAX_MEMBERS && !(readOnly && isDirect);
  const segments = controller.managed?.botSegments ?? [];
  const liveRequests = controller.managed?.botRequests ?? [];
  const placeholder =
    isDirect && owner && !readOnly
      ? t('bots.composer.placeholderDm', { name: owner.name })
      : t('bots.composer.placeholderGroup');
  const introBots = isDirect ? (owner ? [owner] : []) : members;

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
        onSendText={(text) => send(text, [], [])}
        onStarter={prefill}
        onOpenProfile={onOpenProfile}
        readOnly={readOnly}
      />
      {!readOnly && owner && isSproutyBot(owner) && owner.name === 'Sprouty' && owner.current_version === 1 && (
        <SproutyNamingNudge bot={owner} onOpenProfile={onOpenProfile} />
      )}
      {readOnly ? (
        <ReadOnlyNotice
          kind={conversation.kind}
          name={owner?.name ?? null}
          canInvite={canInvite}
          onNewBot={onNewBot}
          onInvite={onInvite}
        />
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
        />
      )}
    </div>
  );
}

/**
 * In place of the composer when nobody here can reply: the history stays
 * readable, and the way forward is one click (a new Bot for a DM, inviting
 * one into an empty group). There is no "restore": an archived Bot's name may
 * already belong to a newer Bot.
 */
function ReadOnlyNotice({
  kind,
  name,
  canInvite,
  onNewBot,
  onInvite,
}: {
  kind: 'direct' | 'group';
  name: string | null;
  canInvite: boolean;
  onNewBot: () => void;
  onInvite: () => void;
}) {
  const t = useT();
  const direct = kind === 'direct';
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
              : t('bots.readOnly.groupTitle')}
          </p>
          <p className="text-xs text-fg-muted">
            {direct ? t('bots.readOnly.dmDescription') : t('bots.readOnly.groupDescription')}
          </p>
        </div>
        {direct ? (
          <Button size="sm" onClick={onNewBot} data-testid="bots-read-only-new-bot">
            <Plus size={14} className="mr-1" />
            {t('bots.sidebar.newBot')}
          </Button>
        ) : (
          canInvite && (
            <Button size="sm" onClick={onInvite}>
              <UserPlus size={14} className="mr-1" />
              {t('bots.header.invite')}
            </Button>
          )
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
