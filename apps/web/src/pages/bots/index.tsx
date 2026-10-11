/**
 * Bots — `#/bots` and `#/bots?c=<sessionId>`.
 *
 * An immersive workspace like Chat (its own conversation header, no
 * ModulePage frame). The page decides where the member lands — first visit
 * creates their first Bot and opens its DM; later visits reopen the most
 * recently active conversation someone can still answer in — and hosts what
 * sits beside the conversation: the info pane, the computer pane (focus
 * layout on take over; the conversation's Agent's own computer, or the one a
 * card was raised on — each Agent has its own), Chat's side pane (html previews, record links — one
 * right-hand column at a time) and the create / invite / profile dialogs. The
 * conversation list lives in the contextual sidebar (mobile: the navigation
 * drawer — every screen here carries the phone's menu button, because the
 * TopBar is hidden on this route).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isSproutyBot, type BotView } from '@greenhouse/types/bots';
import { Button, EmptyState, Spinner } from '../../components/ui';
import { AlertTriangle, Bot } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import * as botsApi from '../../lib/api/bots';
import type { ComputerBot } from '../../lib/api/bots';
import { ComputerPane, type ComputerPaneHandle } from '../../components/bots/computer-pane';
import { ChatSidePane, useSidePaneHost } from '../../components/side-pane/chat-side-pane';
import { useSidePaneStore } from '../../stores/side-pane-store';
import { computerBotFor, useComputerStatus, useComputerTimezoneSync } from '../../components/bots/computer-phase';
import {
  BotsBareHeader,
  BotsDialogs,
  BotsSidePanel,
  ConversationView,
  InfoPanel,
  InviteDialog,
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

export function BotsPage({ params }: { params: URLSearchParams }) {
  const sessionId = params.get('c');
  return sessionId ? <BotsWorkspace sessionId={sessionId} /> : <BotsLanding />;
}

/**
 * No conversation in the URL: open the main thread — the member's DM with Sprouty, their main
 * Agent (spec 20261011-agent-first-class §3.1) — creating it on the first visit, and replace the
 * address. This is where the app's bare address and the conversations entry land.
 */
function BotsLanding() {
  const t = useT();
  const bots = useBotsStore((state) => state.bots);
  const botsLoaded = useBotsStore((state) => state.botsLoaded);
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
    const main = bots.find((bot) => isSproutyBot(bot))?.dm_session_id;
    if (main) {
      openBotsConversation(main, { replace: true });
      return;
    }
    // First visit (or a Sprouty row a chat created without its thread): the API makes sure
    // Sprouty exists, with its DM and a fixed greeting (no model call), idempotently — then we
    // land in that DM.
    ensureSprouty()
      .then(({ dm_session_id }) => openBotsConversation(dm_session_id, { replace: true }))
      .catch((err: unknown) =>
        setFailure({
          status: botsApi.isBotsApiError(err) ? err.status : 0,
          message: err instanceof Error ? err.message : t('bots.setupFailed'),
        }),
      );
  }, [bots, botsLoaded, conversationsLoaded, failure, t]);

  if (failure) {
    const forbidden = failure.status === 403;
    return (
      <div className="flex h-full flex-col" data-testid="bots-landing-error">
        <BotsBareHeader title={t('bots.title')} />
        {!forbidden && <BotsDialogs threadsEnabled />}
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
  const split = useSplitCapable();
  const bots = useBotsStore((state) => state.bots);
  const directory = useBotDirectory();
  const botsState = useBotsLoadState();
  const conversation = controller.conversation;
  const botOf = useCallback((id: string) => directory.get(id), [directory]);
  // Each Agent has its own computer (spec 20261011-agent-first-class P3a). The page's is the
  // conversation's Agent's (Sprouty's = the main one; a DM with an archived owner's too) — not known
  // until the conversation and, for its owner, the Agent list are in.
  const ownerId = conversation?.owner_bot_id ?? null;
  const ownerComputer: ComputerBot | undefined = !conversation
    ? undefined
    : ownerId && !directory.has(ownerId) && botsState === 'loading'
      ? undefined
      : computerBotFor(ownerId, botOf);
  // A card's "Open computer" shows the computer of the Agent that raised it, until the pane closes.
  const [cardComputer, setCardComputer] = useState<{ sessionId: string; bot: ComputerBot } | null>(null);
  const computerBot = cardComputer?.sessionId === sessionId ? cardComputer.bot : ownerComputer;
  // The one computer status of this page: the header's dot, the pane and the
  // human-check cards raised on it read the same copy (no second poller, and an
  // action's result shows everywhere at once).
  const computer = useComputerStatus(computerBot !== undefined, computerBot ?? null);
  // The computer keeps the member's clock (stored once per page load when it differs; it applies to
  // all of the member's computers).
  useComputerTimezoneSync(computer);
  const computerAgent =
    computerBot === undefined
      ? undefined
      : computerBot === null
        ? bots.find((bot) => isSproutyBot(bot))
        : directory.get(computerBot);
  const vaultAvailable = useBotsStore((state) => state.vaultAvailable);
  const dialog = useBotsStore((state) => state.dialog);
  const openDialog = useBotsStore((state) => state.openDialog);
  const openProfile = useBotsStore((state) => state.openProfile);
  const loadBots = useBotsStore((state) => state.loadBots);
  const loadConversations = useBotsStore((state) => state.loadConversations);
  const [pane, setPane] = useState<Pane>(null);
  const [focus, setFocus] = useState(false);
  const computerPaneRef = useRef<ComputerPaneHandle>(null);
  // Chat's side pane lives here too — an html-preview block opens beside the conversation, a
  // record link opens in it — and a preview belongs to the conversation that opened it.
  useSidePaneHost(sessionId);
  const sidePaneOpen = useSidePaneStore((state) => state.isOpen);

  useEffect(() => {
    void loadBots().catch(() => {});
  }, [loadBots]);

  // A Bot that joined (created from a card, invited elsewhere) must have a
  // name here. Once per id: an id the list still lacks after a re-read
  // (neither active nor archived — gone for good) must not re-fetch on every
  // conversation reload.
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
        chat: t('bots.newChat'),
        archived: (name) => t('bots.archivedName', { name }),
      })
    : '';
  const speaking = controller.streaming ? speakingSegment(controller.managed?.botSegments) : null;
  // Named in the take-over confirmation only when it is working on this very computer.
  const speakingName =
    speaking && computerBotFor(speaking.botId, botOf) === computerBot
      ? (directory.get(speaking.botId)?.name ?? null)
      : null;

  const applyPane = useCallback((next: Pane) => {
    setPane(next);
    if (next !== 'computer') {
      setFocus(false);
      // Closed: the next opening shows the conversation's Agent's computer again.
      setCardComputer(null);
    }
    // One right-hand column at a time: info or the computer replaces the side pane…
    if (next !== null) useSidePaneStore.getState().close();
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

  // …and the side pane opening (a preview, a record link) closes info or the computer — through
  // `changePane`, so a member holding the computer is asked to hand it back first.
  const changePaneRef = useRef(changePane);
  changePaneRef.current = changePane;
  const paneRef = useRef(pane);
  paneRef.current = pane;
  useEffect(() => {
    if (sidePaneOpen && paneRef.current !== null) changePaneRef.current(null);
  }, [sidePaneOpen]);

  /**
   * A card's "Open computer": the computer of the Agent that raised it. Showing another computer
   * than the open pane's goes through `requestClose` (a member holding this one hands it back first).
   */
  const computerBotRef = useRef(computerBot);
  computerBotRef.current = computerBot;
  const openAgentComputer = useCallback(
    (botId: string | null) => {
      const target = computerBotFor(botId, botOf);
      const show = () => {
        setCardComputer({ sessionId, bot: target });
        applyPane('computer');
      };
      const open = computerPaneRef.current;
      if (paneRef.current === 'computer' && target !== computerBotRef.current && open) open.requestClose(show);
      else show();
    },
    [applyPane, botOf, sessionId],
  );

  const onReadOnly = useCallback(() => {
    void loadBots().catch(() => {});
    void controller.reload();
  }, [controller, loadBots]);

  const computerPane = (
    <ComputerPane
      // Another Agent's computer is another screen, terminal and file list: start the pane over.
      key={computerBot ?? 'main'}
      ref={computerPaneRef}
      open={pane === 'computer'}
      onClose={() => applyPane(null)}
      sessionId={sessionId}
      focus={focus}
      onFocusChange={setFocus}
      busyBotName={speakingName}
      computer={computer}
      agentName={computerAgent?.name ?? null}
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
          onOpenAgentComputer={openAgentComputer}
          onInvite={() => openDialog({ kind: 'invite', sessionId })}
          onNewBot={() => openDialog({ kind: 'new-bot' })}
          onOpenProfile={(botId) => openProfile(botId)}
        />
      </div>

      <ChatSidePane />

      {pane === 'info' && conversation && (
        <BotsSidePanel title={t('bots.info.title')} onClose={() => changePane(null)} testId="bots-info-pane">
          <InfoPanel
            conversation={conversation}
            onConversationChange={(next) => {
              controller.setConversation(next);
              void loadConversations().catch(() => {});
            }}
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

      <BotsDialogs threadsEnabled onInvited={() => void controller.reload()} />
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
