/**
 * Bots — `#/bots` and `#/bots?c=<sessionId>`.
 *
 * An immersive workspace like Chat (its own conversation header, no
 * ModulePage frame). The page decides where the member lands — first visit
 * creates their first Bot and opens its DM; later visits reopen the most
 * recently active conversation someone can still answer in — and hosts what
 * sits beside the conversation: the info pane, the computer pane (focus
 * layout on take over) and the create / invite / profile dialogs. The
 * conversation list lives in the contextual sidebar (mobile: the navigation
 * drawer — every screen here carries the phone's menu button, because the
 * TopBar is hidden on this route).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotView } from '@greenhouse/types/bots';
import { Button, EmptyState, Spinner } from '../../components/ui';
import { AlertTriangle, Bot } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import * as botsApi from '../../lib/api/bots';
import { ComputerPane, type ComputerPaneHandle } from '../../components/bots/computer-pane';
import { useComputerStatus, useComputerTimezoneSync } from '../../components/bots/computer-phase';
import {
  BotProfileDrawer,
  BotsBareHeader,
  BotsSidePanel,
  ConversationView,
  InfoPanel,
  InviteDialog,
  NewBotDialog,
  NewGroupDialog,
  conversationReplyable,
  conversationTitle,
  ensureSprouty,
  openBotsConversation,
  speakingSegment,
  useBotConversation,
  useBotDirectory,
  useBotsLoadState,
  useBotsStore,
  useSplitCapable,
} from '../../components/bots';

/**
 * Create dialogs and the profile drawer, opened from the sidebar or the page.
 * Mounted on both the landing and the workspace so "New Bot" works even
 * while no conversation is open.
 */
function BotsDialogs({ onInvited }: { onInvited?: () => void }) {
  const dialog = useBotsStore((state) => state.dialog);
  const openDialog = useBotsStore((state) => state.openDialog);
  const openProfile = useBotsStore((state) => state.openProfile);
  const loadConversations = useBotsStore((state) => state.loadConversations);

  const openDm = useCallback(
    async (bot: BotView) => {
      openProfile(null);
      if (bot.dm_session_id) {
        openBotsConversation(bot.dm_session_id);
        return;
      }
      const { conversation: dm } = await botsApi.createConversation({ bot_ids: [bot.id] });
      openBotsConversation(dm.session_id);
    },
    [openProfile],
  );

  return (
    <>
      <BotProfileDrawer onOpenDm={(bot) => void openDm(bot).catch(() => {})} />
      <NewBotDialog
        open={dialog?.kind === 'new-bot'}
        inviteTo={dialog?.kind === 'new-bot' ? dialog.inviteTo : undefined}
        onClose={() => openDialog(null)}
        onCreated={({ dmSessionId, invitedTo, inviteFailed }) => {
          openDialog(null);
          void loadConversations().catch(() => {});
          // Created from Invite: stay in the group either way (a failed join
          // was explained by the dialog); otherwise meet the new Bot.
          if (invitedTo || inviteFailed) onInvited?.();
          else openBotsConversation(dmSessionId);
        }}
      />
      <NewGroupDialog
        open={dialog?.kind === 'new-group'}
        onClose={() => openDialog(null)}
        onNewBot={() => openDialog({ kind: 'new-bot' })}
        onCreated={(created) => {
          openDialog(null);
          void loadConversations().catch(() => {});
          openBotsConversation(created.session_id);
        }}
      />
    </>
  );
}

export function BotsPage({ params }: { params: URLSearchParams }) {
  const sessionId = params.get('c');
  return sessionId ? <BotsWorkspace sessionId={sessionId} /> : <BotsLanding />;
}

/** No conversation in the URL: pick one (or create the first Bot) and replace the address. */
function BotsLanding() {
  const t = useT();
  const bots = useBotsStore((state) => state.bots);
  const botsLoaded = useBotsStore((state) => state.botsLoaded);
  const conversations = useBotsStore((state) => state.conversations);
  const conversationsLoaded = useBotsStore((state) => state.conversationsLoaded);
  const loadBots = useBotsStore((state) => state.loadBots);
  const loadConversations = useBotsStore((state) => state.loadConversations);
  const [failure, setFailure] = useState<{ status: number; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setFailure(null);
    Promise.all([loadBots(), loadConversations()]).catch((err: unknown) =>
      setFailure({
        status: botsApi.isBotsApiError(err) ? err.status : 0,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }, [attempt, loadBots, loadConversations]);

  useEffect(() => {
    if (!botsLoaded || !conversationsLoaded || failure) return;
    // The most recent conversation someone can still answer in: an archived
    // Bot's DM stays listed (read-only) but is no place to land.
    const activeIds = new Set(bots.map((bot) => bot.id));
    const recent =
      conversations.find((conversation) => conversationReplyable(conversation, activeIds))?.session_id ??
      bots.find((bot) => bot.dm_session_id)?.dm_session_id;
    if (recent) {
      openBotsConversation(recent, { replace: true });
      return;
    }
    // First visit (or every other Bot archived): the API makes sure Sprouty exists, with its DM
    // and a fixed greeting (no model call), idempotently — then we land in that DM.
    ensureSprouty()
      .then(({ dm_session_id }) => openBotsConversation(dm_session_id, { replace: true }))
      .catch((err: unknown) =>
        setFailure({
          status: botsApi.isBotsApiError(err) ? err.status : 0,
          message: err instanceof Error ? err.message : t('bots.setupFailed'),
        }),
      );
  }, [bots, botsLoaded, conversations, conversationsLoaded, failure, loadBots, loadConversations, t]);

  if (failure) {
    const forbidden = failure.status === 403;
    return (
      <div className="flex h-full flex-col" data-testid="bots-landing-error">
        <BotsBareHeader title={t('bots.title')} />
        {!forbidden && <BotsDialogs />}
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={forbidden ? Bot : AlertTriangle}
            variant="page"
            tone={forbidden ? 'neutral' : 'danger'}
            title={forbidden ? t('bots.unavailableTitle') : t('bots.loadFailed')}
            description={forbidden ? t('bots.unavailableDescription') : failure.message}
            action={
              forbidden ? undefined : (
                <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>
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
    <div className="flex h-full flex-col">
      <BotsBareHeader title={t('bots.title')} />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center" aria-busy="true">
        <Spinner className="h-5 w-5 text-fg-faint" />
        <p className="text-sm text-fg-muted">{t('bots.loading')}</p>
        <p className="max-w-md text-xs leading-5 text-fg-faint">{t('bots.positioning')}</p>
      </div>
    </div>
  );
}

type Pane = 'info' | 'computer' | null;

function BotsWorkspace({ sessionId }: { sessionId: string }) {
  const t = useT();
  const controller = useBotConversation(sessionId);
  // The one computer status of this page: the header's dot, the pane and the
  // human-check cards read the same copy (no second poller, and an action's
  // result shows everywhere at once).
  const computer = useComputerStatus(true);
  // The computer keeps the member's clock (stored once per page load when it differs).
  useComputerTimezoneSync(computer);
  const split = useSplitCapable();
  const bots = useBotsStore((state) => state.bots);
  const directory = useBotDirectory();
  const botsState = useBotsLoadState();
  const vaultAvailable = useBotsStore((state) => state.vaultAvailable);
  const dialog = useBotsStore((state) => state.dialog);
  const openDialog = useBotsStore((state) => state.openDialog);
  const openProfile = useBotsStore((state) => state.openProfile);
  const loadBots = useBotsStore((state) => state.loadBots);
  const loadConversations = useBotsStore((state) => state.loadConversations);
  const [pane, setPane] = useState<Pane>(null);
  const [focus, setFocus] = useState(false);
  const computerPaneRef = useRef<ComputerPaneHandle>(null);

  useEffect(() => {
    void loadBots().catch(() => {});
  }, [loadBots]);

  // A Bot that joined (created from a card, invited elsewhere) must have a
  // name here. Once per id: an id the list still lacks after a re-read
  // (neither active nor archived — gone for good) must not re-fetch on every
  // conversation reload.
  const conversation = controller.conversation;
  const refetchedFor = useRef(new Set<string>());
  useEffect(() => {
    if (!conversation || botsState !== 'ready') return;
    const unknown = conversation.members
      .map((member) => member.bot_id)
      .filter((id) => !directory.has(id) && !refetchedFor.current.has(id));
    if (unknown.length === 0) return;
    unknown.forEach((id) => refetchedFor.current.add(id));
    void loadBots().catch(() => {});
  }, [botsState, conversation, directory, loadBots]);

  const activeIds = useMemo(() => new Set(bots.map((bot) => bot.id)), [bots]);
  const members = useMemo(
    () =>
      (conversation?.members ?? [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .flatMap((member) => {
          const bot = activeIds.has(member.bot_id) ? directory.get(member.bot_id) : undefined;
          return bot ? [bot] : [];
        }),
    [activeIds, conversation?.members, directory],
  );
  const owner = conversation?.owner_bot_id ? directory.get(conversation.owner_bot_id) : undefined;
  const readOnly = botsState === 'ready' && !!conversation && !conversationReplyable(conversation, activeIds);
  /** Speakers by id (archived ones too — history keeps their names); hand-offs may name the target instead. */
  const lookup = useCallback(
    (idOrName: string | null | undefined): BotView | undefined => {
      if (!idOrName) return undefined;
      const byKey = directory.get(idOrName);
      if (byKey) return byKey;
      const folded = idOrName.replace(/^@/, '').toLocaleLowerCase();
      return members.find((bot) => bot.name.toLocaleLowerCase() === folded);
    },
    [directory, members],
  );
  const title = conversation
    ? conversationTitle(conversation, directory, {
        // Not loaded yet ≠ deleted; the view shows a skeleton meanwhile anyway.
        unknownBot: botsState === 'ready' ? t('bots.deletedBot') : '',
        group: t('bots.sidebar.group'),
        archived: (name) => t('bots.archivedName', { name }),
      })
    : '';
  const speaking = controller.streaming ? speakingSegment(controller.managed?.botSegments) : null;
  const speakingName = speaking ? (directory.get(speaking.botId)?.name ?? null) : null;

  const applyPane = useCallback((next: Pane) => {
    setPane(next);
    if (next !== 'computer') setFocus(false);
  }, []);

  /**
   * Every way of leaving the computer pane — its ✕, the header's Computer and
   * Info buttons, "View summary" in the transcript — asks the pane first: if
   * the member holds control it confirms and hands back (resuming the waiting
   * Bot) before it closes, instead of leaving the Bot blocked behind a lease
   * nobody is using.
   */
  const changePane = useCallback(
    (next: Pane) => {
      const open = computerPaneRef.current;
      if (pane === 'computer' && next !== 'computer' && open) open.requestClose(() => applyPane(next));
      else applyPane(next);
    },
    [applyPane, pane],
  );

  const onReadOnly = useCallback(() => {
    void loadBots().catch(() => {});
    void controller.reload();
  }, [controller, loadBots]);

  const computerPane = (
    <ComputerPane
      ref={computerPaneRef}
      open={pane === 'computer'}
      onClose={() => applyPane(null)}
      sessionId={sessionId}
      focus={focus}
      onFocusChange={setFocus}
      busyBotName={speakingName}
      computer={computer}
    />
  );

  return (
    <div className="flex h-full min-h-0" data-testid="bots-page">
      {/* Focus layout (taking over the computer): the screen gets the main
          area and the conversation narrows to a column beside it. */}
      <div
        className={
          pane === 'computer' && focus && split
            ? 'flex w-[22rem] flex-shrink-0 flex-col border-r border-edge'
            : 'flex min-w-0 flex-1 flex-col'
        }
      >
        <ConversationView
          sessionId={sessionId}
          controller={controller}
          members={members}
          owner={owner}
          lookup={lookup}
          title={title}
          botsState={botsState}
          onRetryBots={() => void loadBots().catch(() => {})}
          readOnly={readOnly}
          onReadOnly={onReadOnly}
          vaultAvailable={vaultAvailable}
          computerPhase={computer.phase}
          computer={computer}
          activePane={pane}
          onPane={changePane}
          onInvite={() => openDialog({ kind: 'invite', sessionId })}
          onNewBot={() => openDialog({ kind: 'new-bot' })}
          onOpenProfile={(botId) => openProfile(botId)}
        />
      </div>

      {pane === 'info' && conversation && (
        <BotsSidePanel title={t('bots.info.title')} onClose={() => changePane(null)} testId="bots-info-pane">
          <InfoPanel
            conversation={conversation}
            onConversationChange={(next) => {
              controller.setConversation(next);
              void loadConversations().catch(() => {});
            }}
            members={members}
            lookup={lookup}
            busy={controller.streaming}
            onOpenProfile={(botId) => openProfile(botId)}
          />
        </BotsSidePanel>
      )}

      {pane === 'computer' &&
        (split ? (
          <div
            className={
              focus
                ? 'flex min-w-0 flex-1 flex-col'
                : 'flex w-[30rem] flex-shrink-0 flex-col border-l border-edge xl:w-[36rem]'
            }
            data-testid="bots-computer-host"
          >
            {computerPane}
          </div>
        ) : (
          <div
            className="fixed inset-0 z-40 flex flex-col bg-surface-canvas safe-area-panel"
            data-testid="bots-computer-host"
          >
            {computerPane}
          </div>
        ))}

      <BotsDialogs onInvited={() => void controller.reload()} />
      <InviteDialog
        conversation={dialog?.kind === 'invite' ? conversation : null}
        onClose={() => openDialog(null)}
        onChanged={(next) => {
          controller.setConversation(next);
          void controller.reload();
          void loadConversations().catch(() => {});
        }}
        onCreateNew={() => openDialog({ kind: 'new-bot', inviteTo: sessionId })}
      />
    </div>
  );
}
