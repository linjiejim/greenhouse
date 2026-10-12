/**
 * `BotThreadScreen` — a Bots conversation as one ongoing thread, rendered on
 * the home route when `?c=<session>` is set (spec
 * docs/specs/20261008-mobile-bots.md §2.5.3). It should feel like a
 * first-party messaging app:
 *
 *  - Chrome (./thread-header.tsx): the title view is the Bot (plant + name +
 *    a live status line — "Browsing github.com", "Waiting for your approval",
 *    its role when idle — tap it for the Bot's profile), ☰ with a badge for
 *    the other conversations that need the member, `⋯` for "New Chat" and
 *    the reply details. No ✎: a thread is not a session.
 *  - Transcript (the vendored `buildTranscript` + ./thread-rows.ts): member
 *    bubbles and Bot replies reuse the conversation's `UserMessage` /
 *    `AiMessage` through ./adapters.ts (markdown, tool rows and their live
 *    sheets, artifacts, ask_user forms — answered *to the Bot that asked*,
 *    D22); a speaker line only when the speaker changes; hand-off strips;
 *    system lines; "needs you" cards (`RequestCard`); Messages-style time
 *    separators; the thread's intro and its starters; "Delivered · Read after
 *    the current reply · Handle Now" / "Not Delivered" under sends.
 *  - Composer: the conversation's, plus Stop left of Send while a run is live
 *    (tap: after this step → now; long press: the menu — ./stop-control.tsx),
 *    the accessory slot above the input (the @-mention strip, else the stop
 *    hint, else the task dock), group "Mention ▸" in `+`, quotes, images
 *    (≤ 3). It never locks: a message sent while Bots work is queued.
 *  - Scrolling (`useTurnAnchor`): opening lands on the end. Every send is
 *    anchored like the conversation's — the keyboard goes down, the bubble
 *    slides under the bar, replies unfold below and the view never chases
 *    them (2026-10: the Messages-style "follow to the end" with the keyboard
 *    up re-scrolled on every streamed word). A queued send never re-anchors.
 *    A run the server started by itself — or one already streaming when the
 *    thread opens — anchors its first speaker when the end is in view,
 *    otherwise the "New Messages ↓" pill lights up ("Needs You ↓" for a card
 *    below). A reply keeps its row from its first word to its persisted copy
 *    (`stableTurnKeys` + one `ReplyRow` type), so nothing jumps when a run
 *    settles. Earlier pages load near the top, keeping the reading position
 *    (D15).
 *  - Effects from the engine: a card arriving in the thread on screen →
 *    warning haptic + one VoiceOver announcement; a Bot starting to reply →
 *    one announcement (never replays, never per token).
 *
 * A task chat (a separate chat — `kind: 'task'`, spec
 * docs/specs/20261011-agent-first-class.md §5a) is this same screen: its title
 * is the chat's (else "New chat"), the intro says it is a separate chat with
 * its Agent, ⋯ adds Tags / Rename / Delete, and while nothing runs its last
 * member message can be edited (the composer takes the text; Send answers it
 * again — `ctl.rewind`) and its last reply regenerated (D23). A new chat's
 * first message arrives from the new-chat screen (`takeFirstSend`) and goes
 * out through the same send path as the composer's. Lines about another chat
 * (`chat_opened` / `chat_origin`) open it.
 *
 * A DM with someone else's public Agent (spec 20261011-agent-first-class §5c P4) is this screen
 * too: the intro says who shared it (and that they can't read it), ⋯ has no "New Chat" (a chat
 * with it is this DM — no task chats with someone else's Agent), 🖥 shows only when its owner
 * granted it a computer (the member's own copy — `shared_bots[].computer`) and it is still offered,
 * its replies offer 👍 / 👎 (an optional note with 👎; the member's rating comes with each page,
 * and choosing it again takes it back), and once it is no longer offered the thread is read-only
 * (`agent_unavailable`) like an archived Agent's.
 *
 * A room (several people and the Agents they brought, spec
 * 20261011-agent-first-class §5d P5) is this screen too: its title is the room's
 * (else the other people's names) over their initials, its status line says who
 * is in it; other people's messages sit on the left under their name; an Agent
 * answers only when @-mentioned by someone it may answer, so the @ picker (and
 * `+` → Ask an Agent) offers only the Agents the member may address, every send
 * answers 202 (the engine's room handling) and a run is its asker's — no Stop,
 * no Handle Now and no cards to act on in someone else's. People talking (a
 * message that asks no Agent, another person's message while the end is in
 * view) scroll Messages-style — the keyboard stays, the end stays in view; an
 * Agent's reply is anchored like everywhere else. ⋯ is the room's: who
 * is in it, Add People… (`/bots/new-room?room=`), Bring an Agent ›, Remove an
 * Agent ›, Rename, Leave (confirmed). No New Chat and no 🖥: a room has no Agent
 * of its own (each Agent's computer is reached from its cards).
 *
 * The engine (`useBotThread`, package A) owns sending, streaming, stops,
 * reloads, read receipts; this screen only renders its snapshot and routes
 * the member's intents to its controller. Streaming re-renders the screen
 * ~30×/s: rows (./rows — the message rows in ./rows/turns.tsx) are memoised
 * on their *source* objects (the engine shares structure), callbacks are
 * stable, and the header reads its own store. The composer's draft lives in
 * ./drafts.ts, the mention picker in ./use-mention-picker.ts.
 */

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  AppState,
  Keyboard,
  Platform,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextInput,
} from 'react-native';
import { useIsFocused, useNavigation, useRouter } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeOut, useSharedValue } from 'react-native-reanimated';
import { KeyboardChatScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import * as Clipboard from 'expo-clipboard';
import { Composer, ReadOnlyBar } from '../../chat/composer';
import { draftsFor, useComposerBridge } from '../../chat/composer-bridge';
import { openTurn, publishTurns } from '../../chat/live-turn';
import type { MessageAction } from '../../chat/message';
import { excerpt, plainText, type ChatMessage } from '../../chat/model';
import { useTurnAnchor } from '../../chat/use-turn-anchor';
import { putHandoff } from '../../lib/handoff';
import { t as tNow, useT } from '../../lib/i18n';
import { splitAttachments } from '../../shared/rich-output';
import { botTemplate, isSproutyBot, type BotRequestView, type BotView } from '../../shared/bots';
import type { BotStreamSegment } from '../../shared/bots-wire';
import { usePrefs } from '../../store/prefs';
import { HIT, makeStyles, radius, space, typo, useTheme, weight } from '../../theme';
import { NativeButton } from '../../ui/button';
import { Icon, Touchable } from '../../ui/core';
import { alertError } from '../../ui/dialogs';
import { EmptyState, LoadingState } from '../../ui/empty';
import { Glass, GlassIconButton } from '../../ui/glass';
import { notifyWarning, selectionTick } from '../../ui/haptics';
import { useHeaderInset } from '../../ui/header-inset';
import { toast } from '../../ui/toast';
import { deleteSession } from '../../api/sessions';
import { addRoomAgent, leaveRoom, removeRoomAgent, renameRoom, updateTaskChat } from '../../api/bots';
import { confirmAction, promptText } from '../../ui/dialogs';
import type { BotsReadOnly, MobilePending, RewindInput, RewindOutcome, SendInput, SendOutcome } from '../contract';
import { forgetGoneThread } from '../last-surface';
import { openNewChat, openThread } from '../nav';
import { attentionCount, useBots } from '../store';
import { computerOffered, rateableReply, sharedOwnerOf } from '../public-agents';
import {
  bringableAgents,
  isPrivateChat,
  lastOneIn,
  mentionableAgents,
  needsOffered,
  personName,
  personTint,
  removableAgents,
  roomDirectory,
  roomFaces,
  roomOwnerId,
} from '../rooms';
import { computerAgent, computerButtonTone, conversationComputer } from '../computer/target';
import { useComputerStatus } from '../computer/use-computer-status';
import { phaseLabelKey } from '../vendor/computer-phase';
import {
  editedContent,
  rewindRefusalKey,
  rewindTarget,
  takeFirstSend,
  threadTitle,
  transcriptKind,
} from '../task-chats';
import { BotAvatar, type AvatarSource } from '../ui/bot-avatar';
import { useBotThread } from '../use-bot-thread';
import { useStartupContent } from '../../startup/context';
import { mentionToken, parseMentions } from '../vendor/mentions';
import { buildTranscript, type TranscriptItem } from '../vendor/transcript';
import { fromSegment } from './adapters';
import { threadCache } from './cache';
import { saveDraft, useThreadDraft, type ThreadDraft } from './drafts';
import { EditBar } from './edit-bar';
import { MentionStrip } from './mention-strip';
import { EventRow } from './rows/event-row';
import { HandoffRow } from './rows/handoff-row';
import { Intro } from './rows/intro';
import { RunTail } from './rows/run-tail';
import { wantsNameHint } from './rows/sprouty-name';
import { Starters } from './rows/starters';
import { TaskReport } from './rows/task-report';
import {
  PendingRow,
  PersonRow,
  ReplyRow,
  RequestRow,
  UserRow,
  type ReplyHandlers,
  type ReplyRowProps,
} from './rows/turns';
import { TimeSeparator } from './rows/time-separator';
import { TopLoader } from './rows/top-loader';
import { CHEER_MS, cheerPose, statusLine, threadReadOnly, talkingSegment, titlePose } from './status-line';
import { StopHint, useComposerStop } from './stop-control';
import { TaskDock } from './task-dock';
import {
  dropThreadHeader,
  publishThreadHeader,
  ThreadHeader,
  type RoomMenu,
  type ThreadHeaderActions,
} from './thread-header';
import { stableTurnKeys, threadRows, type ThreadRow } from './thread-rows';
import {
  deepLinkStep,
  expectOnRunSettled,
  expectOnRunStarted,
  prependStep,
  pruneRowGeometry,
  hintFits,
  showsFreshPage,
  type ExpectAnchor,
} from './thread-screen-model';
import { useBotTasks } from './use-bot-tasks';
import { useMentionPicker } from './use-mention-picker';

/**
 * D15: how prepended pages keep the reading position — `mvcp` lets the
 * scroll view do it (maintainVisibleContentPosition, on only while a page
 * lands), `delta` scrolls by the height the page added. Flip if MVCP proves
 * unreliable on Fabric (spec V11).
 */
const PREPEND_MODE: 'mvcp' | 'delta' = 'mvcp';
/** Images per message (the web's Bots composer allows the same). */
const MAX_IMAGES = 3;
/** Earlier pages load by themselves within this distance of the top… */
const EARLIER_THRESHOLD = 400;
/** …this many in a row; the next one waits for a tap. */
const AUTO_PAGES = 5;
/** A deep-linked card stays highlighted this long. */
const HIGHLIGHT_MS = 1200;
const MVCP = { minIndexForVisible: 1 } as const;
/** The jump control's drawn height; its touch frame is a full `HIT` (padding handed back by negative margins). */
const JUMP_H = 38;
/** The "couldn't refresh" pill's drawn height; its touch frame too is a full `HIT`. */
const REFRESH_H = HIT - 10;
/** Not a row key (rows are never keyed ''): resets the row the anchor hook last measured. */
const NO_ROW = '';

/** A row's geometry as the `onLayout` event the anchor hook takes. */
const layoutEvent = (y: number, h: number) =>
  ({ nativeEvent: { layout: { x: 0, y, width: 0, height: h } } }) as LayoutChangeEvent;

const EMPTY_SEGMENTS: BotStreamSegment[] = [];
const EMPTY_REQUESTS: BotRequestView[] = [];
const NO_BOTS: BotView[] = [];
const NO_STARTERS: readonly string[] = [];
const NO_IDS: readonly string[] = [];

/** The same object for as long as `key` says it is the same (a memoised bar must not rebuild on equal data). */
function useStable<T>(value: T, key: string): T {
  const ref = useRef({ key, value });
  if (ref.current.key !== key) ref.current = { key, value };
  return ref.current.value;
}

/** What a message shows — a member message without its attachments fence (that's for chips, not for copying). */
const visibleText = (msg: ChatMessage) => (msg.role === 'user' ? splitAttachments(msg.text).text : msg.text);

/** The "back to latest" control at the composer's top-right: a round arrow, or a pill when something new is below. */
const JumpButton = memo(function JumpButton({
  kind,
  bot,
  onPress,
}: {
  kind: 'latest' | 'new' | 'needs';
  bot: AvatarSource | null;
  onPress: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  if (kind === 'latest') {
    return (
      <GlassIconButton
        icon="arrowDown"
        size={JUMP_H}
        style={styles.jumpHitRound}
        accessibilityLabel={t('bots.thread.latest')}
        onPress={onPress}
      />
    );
  }
  const label = kind === 'needs' ? t('bots.thread.needsYouJump') : t('bots.thread.newMessages');
  const tint = kind === 'needs' ? c.orange : c.label;
  return (
    <Touchable
      onPress={onPress}
      pressedStyle={{}}
      style={styles.jumpHitPill}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Glass interactive style={styles.jumpPill}>
        {bot ? <BotAvatar bot={bot} size={22} animate={false} /> : null}
        <Text style={[styles.jumpText, { color: tint }]}>{label}</Text>
        <Icon name="arrowDown" size={12} weight="bold" color={tint} />
      </Glass>
    </Touchable>
  );
});

/* ------------------------------ screen ------------------------------ */

export function BotThreadScreen({
  sessionId,
  title: titleParam,
  request,
  compose,
}: {
  sessionId: string;
  /** Placeholder title until the conversation loads. */
  title: string;
  /** A card to scroll to and highlight (deep links). */
  request: string;
  /** Focus the composer on open. */
  compose: boolean;
}): React.JSX.Element {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width: winWidth, fontScale } = useWindowDimensions();
  const headerHeight = useHeaderInset();
  const focused = useIsFocused();

  const { snap, ctl } = useBotThread(sessionId);
  useStartupContent(snap.load !== 'loading');
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const storeById = useBots((s) => s.byId);
  const shared = useBots((s) => s.shared);
  const viewerId = useBots((s) => s.viewerId);
  const offered = useBots((s) => s.directory);
  const ownBots = useBots((s) => s.bots);
  const ratings = useBots((s) => s.ratings);
  const botsLoaded = useBots((s) => s.botsLoaded);
  const badge = useBots((s) => attentionCount(s, sessionId));

  /* ---------- who is here ---------- */
  const conversation = snap.conversation;
  const kind = conversation?.kind ?? 'direct';
  const group = kind === 'group';
  /** A room (several people, P5), else null. */
  const room = kind === 'room' ? conversation : null;
  // Every Agent that spoke here (some may have left a room since) — as one stable key: segments
  // change on every streamed word, the speakers almost never.
  const speakerKey = useMemo(() => {
    if (!room) return '';
    const ids = new Set<string>();
    for (const message of snap.messages) if (message.bot_id) ids.add(message.bot_id);
    for (const segment of snap.run?.segments ?? []) ids.add(segment.botId);
    return [...ids].sort().join(',');
  }, [room, snap.messages, snap.run?.segments]);
  const agentCopy = useMemo(
    () => ({ agentOf: (name: string) => t('bots.room.agentOf', { name }), someAgent: t('bots.room.someAgent') }),
    [t],
  );
  // In a room, another person's Agent shows as the room describes it (`members[].profile`); one nothing
  // describes (an older server) gets a card too — "Ana's Agent" (../rooms.ts `roomDirectory`).
  const roomDir = useMemo(
    () =>
      room
        ? roomDirectory({
            byId: storeById,
            room,
            offered,
            speakers: speakerKey ? speakerKey.split(',') : NO_IDS,
            viewerId,
            copy: agentCopy,
          })
        : null,
    [room, storeById, offered, speakerKey, viewerId, agentCopy],
  );
  const byId = roomDir?.byId ?? storeById;
  // A public Agent the member may @ here but neither a list nor the room names (an older server):
  // "Browse Agents" has it (once per thread).
  const askedOffered = useRef(false);
  useEffect(() => {
    if (!room || askedOffered.current || !needsOffered(room, storeById, offered)) return;
    askedOffered.current = true;
    void useBots.getState().loadDirectory();
  }, [room, storeById, offered]);
  const owner = conversation?.owner_bot_id ? byId[conversation.owner_bot_id] : undefined;
  /** Someone else's public Agent this DM is with (P4), else null. */
  const sharedOwner = kind === 'direct' ? sharedOwnerOf(conversation, shared) : null;
  const memberList = conversation?.members;
  /**
   * Active members in their order (a DM: its Bot and any guests) — mentions, the roster, the lookup by
   * name. A room: only the Agents the member may @ (their own, or public ones offered to them).
   */
  const members = useMemo(
    () =>
      room && roomDir
        ? mentionableAgents(room, roomDir.byId, roomDir.guessed)
        : memberList
          ? [...memberList]
              .sort((a, b) => a.position - b.position)
              .flatMap((member) => {
                const bot = byId[member.bot_id];
                return bot && bot.status === 'active' ? [bot] : [];
              })
          : NO_BOTS,
    [room, roomDir, memberList, byId],
  );
  /** Speakers by id (archived ones too — history keeps their names); hand-offs may name the target instead. */
  const lookup = useCallback(
    (idOrName: string | null | undefined): BotView | undefined => {
      if (!idOrName) return undefined;
      const byKey = byId[idOrName];
      if (byKey) return byKey;
      const folded = idOrName.replace(/^@/, '').toLocaleLowerCase();
      return members.find((bot) => bot.name.toLocaleLowerCase() === folded);
    },
    [byId, members],
  );
  /**
   * May the member act on what this Agent put in the transcript — its forms and buttons, a Retry?
   * In a room only on an Agent they may address (another person's answers to that person).
   */
  const answerable = useCallback(
    (botId: string | null | undefined) =>
      !room || !botId || room.members.some((member) => member.bot_id === botId && member.addressable === true),
    [room],
  );
  const readOnlyCode = threadReadOnly(snap, byId, shared);
  const readOnly = readOnlyCode != null;
  const directory = useMemo(() => new Map(Object.entries(byId)), [byId]);
  const task = kind === 'task';
  const displayTitle =
    (conversation &&
      threadTitle(conversation, directory, {
        // Not loaded yet ≠ deleted: keep the placeholder meanwhile.
        unknownBot: botsLoaded ? t('bots.common.deletedBot') : '',
        group: t('bots.thread.group'),
        archived: (name) => `${name} ${t('bots.common.archivedSuffix')}`,
        chat: t('chat.newConversation'),
        room: { me: viewerId, untitled: t('bots.room.untitled') },
      })) ||
    titleParam;
  const privateChat = !!room && isPrivateChat(room);
  const roomRef = useRef(room);
  roomRef.current = room;
  /** A room's people as its avatar shows them (stable while they are the same). */
  const faces = useMemo(
    () => (room ? roomFaces(room, viewerId).map((person) => ({ id: person.user_id, name: person.nickname })) : null),
    [room, viewerId],
  );
  const people = useStable(faces, faces ? faces.map((face) => `${face.id}:${face.name}`).join('|') : '');
  /** Someone else's run in a room: its cards are its asker's — only the member's own (`conversation.requests`) count. */
  const requests = useMemo(() => {
    if (!room || snap.runMine) return snap.requests;
    const mine = new Set(room.requests.map((request) => request.id));
    return new Map([...snap.requests].filter(([id]) => mine.has(id)));
  }, [room, snap.runMine, snap.requests]);

  /* ---------- a thread that is gone is not reopened on the next cold start (D3; home remembers it) ---------- */
  // …neither as the last thread nor as the remembered main thread (../last-surface.ts).
  const gone = snap.load === 'not_found' || snap.load === 'forbidden';
  useEffect(() => {
    if (gone) forgetGoneThread(sessionId);
  }, [gone, sessionId]);

  /* ---------- transcript rows ---------- */
  const ready = snap.load === 'ready';
  const showRows = ready || snap.messages.length > 0;
  const segments = snap.run?.segments ?? EMPTY_SEGMENTS;
  const runKey = snap.run?.key ?? '';
  // A reply keeps one row key from its first word to its persisted copy (./thread-rows.ts).
  const turnKeys = useRef(new Map<string, string>());
  const items = useMemo(
    () =>
      stableTurnKeys(
        buildTranscript({
          messages: snap.messages,
          // a task chat reads like a DM: its Agent speaks under the title; a room names everyone
          conversationKind: transcriptKind(kind),
          ownerBotId: conversation?.owner_bot_id ?? null,
          segments,
          // (someone else's run in a room: its cards are theirs)
          liveRequests: (room && !snap.runMine ? undefined : snap.run?.requests) ?? EMPTY_REQUESTS,
          pending: snap.pending,
          requests,
          me: viewerId,
        }),
        { runKey, segments, known: turnKeys.current },
      ),
    [
      snap.messages,
      kind,
      conversation?.owner_bot_id,
      segments,
      room,
      snap.runMine,
      snap.run?.requests,
      snap.pending,
      requests,
      viewerId,
      runKey,
    ],
  );
  const rows = useMemo(
    () => threadRows(items, { hasMore: snap.hasMore, replyable: !readOnly, locale: lang }),
    [items, snap.hasMore, readOnly, lang],
  );
  /** The member message that followed each Bot reply (an ask_user / confirm answer), by message id. */
  const followUps = useMemo(() => {
    const out = new Map<string, string>();
    items.forEach((item, index) => {
      if (item.kind !== 'bot') return;
      const next = items[index + 1];
      if (next?.kind === 'user') out.set(item.message.id, next.message.content);
      else if (next?.kind === 'pending') out.set(item.message.id, next.pending.content);
    });
    return out;
  }, [items]);
  const taskRows = useMemo(
    () =>
      snap.messages.filter((m) => m.bot_event?.kind === 'task_started' || m.bot_event?.kind === 'task_report').length,
    [snap.messages],
  );
  /** The live segments as replies — one object per segment, shared by the rows and the live sheets. */
  const liveMessages = useMemo(
    () =>
      segments.map((segment, index) =>
        fromSegment(segment, {
          id: `${runKey}#${index}`,
          errorText: t('bots.thread.turnFailed', { name: lookup(segment.botId)?.name ?? t('bots.common.deletedBot') }),
        }),
      ),
    [segments, runKey, lookup, t],
  );
  // a reply's sheets (tools, reasoning) follow it while it streams
  useEffect(() => {
    if (liveMessages.length) publishTurns(liveMessages);
  }, [liveMessages]);

  /* ---------- the title view ---------- */
  const status = statusLine({ snap: room ? { ...snap, requests } : snap, byId, kind, shared });
  const statusText = status ? t(status.key, status.vars) : '';
  // A brief smile when a reply finishes: the run ends without an error and nobody stopped it.
  const [cheering, setCheering] = useState(false);
  const runSeen = useRef({ active: snap.runActive, stopped: false });
  useEffect(() => {
    const seen = runSeen.current;
    if (snap.runActive) {
      seen.stopped ||= snap.stopPhase !== null;
      seen.active = true;
      setCheering(false);
      return;
    }
    if (seen.active && !seen.stopped && !snap.runError) setCheering(true);
    else if (snap.runError) setCheering(false);
    runSeen.current = { active: false, stopped: false };
  }, [snap.runActive, snap.stopPhase, snap.runError]);
  useEffect(() => {
    if (!cheering) return;
    const timer = setTimeout(() => setCheering(false), CHEER_MS);
    return () => clearTimeout(timer);
  }, [cheering]);
  const pose = cheerPose(titlePose({ snap, byId, kind, shared }), cheering);
  const speakingId = talkingSegment(snap.run)?.botId ?? null;
  const headerBots = useMemo<Array<AvatarSource | null>>(() => {
    if (!group) return [owner ?? null];
    const speaking = members.find((bot) => bot.id === speakingId);
    return (speaking ? [speaking, ...members.filter((bot) => bot !== speaking)] : members).slice(0, 3);
  }, [group, owner, members, speakingId]);
  // before paint: the bar never shows a stale status for a frame
  useLayoutEffect(() => {
    publishThreadHeader(sessionId, {
      title: displayTitle,
      status: statusText,
      bots: headerBots,
      pose,
      group,
      ownerBotId: owner?.id ?? null,
      ...(people ? { people } : {}),
    });
  }, [sessionId, displayTitle, statusText, headerBots, pose, group, owner?.id, people]);
  useEffect(() => () => dropThreadHeader(sessionId), [sessionId]);

  /* ---------- composer state (the draft survives switching threads) ---------- */
  const inputRef = useRef<TextInput>(null);
  const draft = useThreadDraft(sessionId, MAX_IMAGES);
  const { text: input, setText: setInput, images, annotations, take, giveBack, addQuotes } = draft;
  /**
   * Editing a task chat's last message: Send answers it again with the new text (`ctl.rewind`).
   * `original` is the message's content (its file fences are kept), `held` the draft the composer
   * had before — Cancel or a sent edit puts it back.
   */
  const [editing, setEditing] = useState<{ messageId: string; original: string; held: ThreadDraft } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [composerH, setComposerH] = useState(60);
  const composerBottom = Math.max(insets.bottom, space.md) + (Platform.OS === 'android' ? space.sm : 0);
  const extraPad = useSharedValue(60 + composerBottom + space.md);
  const onComposerHeight = useCallback(
    (h: number) => {
      setComposerH(h);
      extraPad.value = h + composerBottom + space.md;
    },
    [extraPad, composerBottom],
  );
  const focusInput = useCallback(() => setTimeout(() => inputRef.current?.focus(), 300), []);
  // Sheets hand context back through the bridge (a source's "Ask about this" in a reply's references).
  const bridged = useComposerBridge((s) => s.pending.length);
  const readOnlyNow = useRef(readOnly);
  readOnlyNow.current = readOnly;
  useEffect(() => {
    if (!bridged) return;
    const texts = useComposerBridge.getState().take();
    if (readOnlyNow.current) return;
    addQuotes(texts);
    focusInput();
  }, [bridged, focusInput, addQuotes]);
  // An html-preview page's sendPrompt: text INTO the composer, after what is typed — never sent.
  const drafted = useComposerBridge(draftsFor(sessionId));
  useEffect(() => {
    if (!drafted) return;
    const texts = useComposerBridge.getState().takeDrafts(sessionId);
    if (readOnlyNow.current) return;
    setInput([input.trim() ? input : '', ...texts].filter(Boolean).join('\n'));
    focusInput();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- append to the input as it is when the text arrives
  }, [drafted, focusInput, sessionId]);

  /* ---------- the floating layer under the bar: "couldn't refresh" ---------- */
  const [topLayerH, setTopLayerH] = useState(0);
  const onTopLayer = useCallback((e: LayoutChangeEvent) => setTopLayerH(Math.round(e.nativeEvent.layout.height)), []);
  const topPad = headerHeight + space.sm + (topLayerH ? topLayerH + space.xs : 0);

  /* ---------- scrolling: land on the end, follow or anchor a send (see header) ---------- */
  const bottomInset = useCallback(() => composerH + composerBottom + space.md, [composerH, composerBottom]);
  const bottomInsetRef = useRef(bottomInset);
  bottomInsetRef.current = bottomInset;
  const anchor = useTurnAnchor({ topPad, bottomInset });
  const {
    scrollRef,
    blankSpace,
    endVisible,
    onEndVisible,
    onViewport: anchorViewport,
    onContentSize: anchorContentSize,
    onScroll: anchorScroll,
    onDragStart: anchorDragStart,
    onAnchorRowLayout,
    anchorNext,
    holdingEnd,
    holdForTurn,
    cancelTurn,
    jumpToLatest,
    landOnEnd,
    shift,
  } = anchor;
  const endVisibleRef = useRef(endVisible);
  endVisibleRef.current = endVisible;
  /** Viewport height, content height, scroll offset. */
  const geo = useRef({ viewport: 0, content: 0, offset: 0 });
  /** Where every row sits in the content (anchoring, the deep-linked card, "needs you ↓"). */
  const rowGeo = useRef(new Map<string, { y: number; h: number }>());
  /** The row the next anchor is waiting for. */
  const anchorKey = useRef<string | null>(null);
  /** A send / server run whose first row should be anchored once it appears (./thread-screen-model.ts). */
  const expectAnchor = useRef<ExpectAnchor>(null);

  /**
   * Anchor the turn to this row. A key can come back as another row (every
   * run's first reply is `segment:0`), so only the row mounted now may place
   * the anchor: the anchor hook forgets the row it measured last, and the
   * cached geometry is replayed only if this row has been laid out already —
   * otherwise its own `onLayout` lands it.
   */
  const anchorTo = useCallback(
    (key: string) => {
      anchorKey.current = key;
      onAnchorRowLayout(NO_ROW, layoutEvent(0, 0));
      anchorNext(key);
      const g = rowGeo.current.get(key);
      if (g) onAnchorRowLayout(key, layoutEvent(g.y, g.h));
    },
    [anchorNext, onAnchorRowLayout],
  );

  // One stable onLayout per row key (rows re-render every stream tick); it reads the anchor through a ref.
  const anchorRowLayout = useRef(onAnchorRowLayout);
  anchorRowLayout.current = onAnchorRowLayout;
  const layoutHandlers = useRef(new Map<string, (e: LayoutChangeEvent) => void>());
  const rowLayout = useCallback((key: string) => {
    let handler = layoutHandlers.current.get(key);
    if (!handler) {
      handler = (e: LayoutChangeEvent) => {
        const { y, height } = e.nativeEvent.layout;
        rowGeo.current.set(key, { y, h: height });
        if (anchorKey.current === key) anchorRowLayout.current(key, e);
      };
      layoutHandlers.current.set(key, handler);
    }
    return handler;
  }, []);
  // Geometry lives as long as its row (before this commit's effects can anchor anything).
  useLayoutEffect(() => {
    const mounted = showRows ? rows.map((row) => row.key) : [];
    pruneRowGeometry(rowGeo.current, mounted);
    pruneRowGeometry(layoutHandlers.current, mounted);
  }, [rows, showRows]);

  // A send's bubble appeared: anchor it (keyboard down — see `dispatchSend`).
  const seenPending = useRef(new Set<string>());
  useEffect(() => {
    for (const pending of snap.pending) {
      if (seenPending.current.has(pending.clientId)) continue;
      seenPending.current.add(pending.clientId);
      if (expectAnchor.current?.kind === 'pending') {
        expectAnchor.current = null;
        anchorTo(`pending:${pending.clientId}`);
      }
    }
  }, [snap.pending, anchorTo]);
  // A run the server started by itself: anchor its first speaker (when the end was in view) — and
  // one already streaming when the thread opened (its start may predate this screen's listener):
  // while the end is still held from opening, its reply is anchored, never followed.
  const firstSegmentKey = segments.length ? (items.find((item) => item.kind === 'segment')?.key ?? null) : null;
  useEffect(() => {
    if (!firstSegmentKey) return;
    if (expectAnchor.current?.kind === 'segment' || (expectAnchor.current === null && holdingEnd())) {
      expectAnchor.current = null;
      anchorTo(firstSegmentKey);
    }
  }, [firstSegmentKey, anchorTo, holdingEnd]);

  // A room: another person's message while the member reads the end — people talking are followed
  // (Messages-style); a reply streaming is not (its turn is anchored, never chased).
  const lastItem = items[items.length - 1];
  const lastPerson = lastItem?.kind === 'person' ? lastItem.key : null;
  useEffect(() => {
    if (lastPerson && endVisibleRef.current && !snapRef.current.runActive) landOnEnd();
  }, [lastPerson, landOnEnd]);

  /* ---------- earlier pages (D15) ---------- */
  const dragged = useRef(false);
  const autoPages = useRef(0);
  const [manualEarlier, setManualEarlier] = useState(false);
  const [mvcp, setMvcp] = useState(false);
  const firstMessageId = snap.messages[0]?.id ?? null;
  const firstMessageRef = useRef(firstMessageId);
  firstMessageRef.current = firstMessageId;
  const prepend = useRef<{ height: number; first: string | null } | null>(null);
  const loadEarlier = useCallback(
    (auto: boolean) => {
      const s = snapRef.current;
      if (!s.hasMore || s.earlier === 'loading' || prepend.current) return;
      if (auto) {
        if (s.earlier === 'error') return;
        if (autoPages.current >= AUTO_PAGES) {
          setManualEarlier(true);
          return;
        }
        autoPages.current += 1;
      } else {
        autoPages.current = 0;
        setManualEarlier(false);
      }
      prepend.current = { height: geo.current.content, first: firstMessageRef.current };
      if (PREPEND_MODE === 'mvcp') setMvcp(true);
      void ctl.loadEarlier();
    },
    [ctl],
  );
  const loadEarlierByHand = useCallback(() => loadEarlier(false), [loadEarlier]);
  // A page that failed — or came back with nothing older — never lands: release the position hold.
  useEffect(() => {
    const p = prepend.current;
    if (!p || snap.earlier === 'loading') return;
    if (snap.earlier === 'idle' && firstMessageId !== p.first) return; // landed: onContentSize takes it
    prepend.current = null;
    setMvcp(false);
  }, [snap.earlier, firstMessageId]);

  /* ---------- "new messages ↓" / "needs you ↓" ---------- */
  const lastRow = rows[rows.length - 2];
  const lastKey = lastRow?.key ?? null;
  const lastSeenKey = useRef(lastKey);
  if (endVisible) lastSeenKey.current = lastKey;
  const hasNew = !endVisible && (lastKey !== lastSeenKey.current || snap.runActive);
  const pendingCards = useMemo(
    () =>
      rows.flatMap((row) =>
        row.kind === 'request' && requests.get(row.requestId)?.status === 'pending'
          ? [{ key: row.key, botId: row.botId }]
          : [],
      ),
    [rows, requests],
  );
  const pendingCardsRef = useRef(pendingCards);
  pendingCardsRef.current = pendingCards;
  const [cardBelow, setCardBelow] = useState<{ key: string; botId: string | null } | null>(null);
  const checkBelow = useCallback(() => {
    const { offset, viewport } = geo.current;
    const bottom = offset + viewport - bottomInsetRef.current();
    const hit =
      pendingCardsRef.current.find((card) => {
        const g = rowGeo.current.get(card.key);
        return !!g && g.y > bottom;
      }) ?? null;
    setCardBelow((prev) => (prev?.key === hit?.key ? prev : hit));
  }, []);
  useEffect(() => {
    checkBelow();
  }, [pendingCards, endVisible, checkBelow]);

  /* ---------- scroll view wiring ---------- */
  const onViewport = useCallback(
    (e: LayoutChangeEvent) => {
      geo.current.viewport = e.nativeEvent.layout.height;
      anchorViewport(e);
    },
    [anchorViewport],
  );
  const onContentSize = useCallback(
    (w: number, h: number) => {
      const p = prepend.current;
      if (p) {
        const step = prependStep(p, firstMessageRef.current, h);
        if (step.landed) {
          // An earlier page landed above: keep what the member was reading in place.
          prepend.current = null;
          if (step.delta > 0) {
            if (PREPEND_MODE === 'delta') {
              scrollRef.current?.scrollTo({ y: geo.current.offset + step.delta, animated: false });
            }
            shift(step.delta);
          }
          if (PREPEND_MODE === 'mvcp') requestAnimationFrame(() => setMvcp(false));
        } else {
          // Still in flight: what grew meanwhile (a reply streaming) is not the page's.
          prepend.current = step.hold;
        }
      }
      geo.current.content = h;
      anchorContentSize(w, h);
    },
    [anchorContentSize, shift, scrollRef],
  );
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      anchorScroll(e);
      geo.current.offset = e.nativeEvent.contentOffset.y;
      if (dragged.current && geo.current.offset < EARLIER_THRESHOLD) loadEarlier(true);
      checkBelow();
    },
    [anchorScroll, loadEarlier, checkBelow],
  );
  const onDragStart = useCallback(() => {
    dragged.current = true;
    anchorDragStart();
  }, [anchorDragStart]);

  /* ---------- deep link: scroll to a card and highlight it ---------- */
  const [highlighted, setHighlighted] = useState<string | null>(null);
  // The in-memory copy this thread opens with (the engine shows it first): a card raised since is not in it.
  const openedWith = useMemo(
    () => threadCache.get(sessionId, useBots.getState().generation)?.conversation ?? null,
    [sessionId],
  );
  const fresh = showsFreshPage({ conversation: snap.conversation, openedWith, refreshFailed: snap.refreshFailed });
  const handledRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!request) {
      handledRequest.current = null;
      return;
    }
    if (handledRequest.current === request) return; // the param is on its way out
    const key = `request:${request}`;
    const step = deepLinkStep({ ready, found: rows.some((row) => row.key === key), fresh });
    if (step === 'wait') return;
    handledRequest.current = request;
    if (step === 'anchor') {
      anchorTo(key);
      setHighlighted(request);
    }
    router.setParams({ request: '' });
  }, [request, ready, rows, fresh, anchorTo, router]);
  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);

  // `?compose=1` on a thread already open (autoFocus only applies on mount).
  useEffect(() => {
    if (!compose) return;
    focusInput();
    router.setParams({ compose: '' });
  }, [compose, focusInput, router]);

  /* ---------- engine effects → haptics, VoiceOver, anchoring a server run ---------- */
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  const announced = useRef(new Set<string>());
  useEffect(
    () =>
      ctl.onEffect((e) => {
        // on screen: focused (no sheet over it) and in the foreground
        const visible = focusedRef.current && AppState.currentState === 'active';
        if (e.type === 'segment-start') {
          if (e.replayed || !visible) return;
          const name = lookupRef.current(e.botId)?.name;
          if (name) AccessibilityInfo.announceForAccessibility(tNow('bots.thread.announceReplying', { name }));
        } else if (e.type === 'request-arrived') {
          if (e.replayed || e.request.status !== 'pending' || !visible || announced.current.has(e.request.id)) return;
          // (a room: someone else's run's card is theirs)
          if (!snapRef.current.runMine) return;
          announced.current.add(e.request.id);
          notifyWarning();
          const name = lookupRef.current(e.request.bot_id)?.name ?? tNow('bots.common.deletedBot');
          AccessibilityInfo.announceForAccessibility(tNow('bots.thread.announceNeedsYou', { name }));
        } else if (e.type === 'run-started') {
          // A run nobody here sent: follow it only if the member is at the end with the keyboard down.
          expectAnchor.current = expectOnRunStarted(expectAnchor.current, e, { endVisible: endVisibleRef.current });
        } else if (e.type === 'run-settled') {
          // It never showed a reply: nothing is waiting for one any more.
          expectAnchor.current = expectOnRunSettled(expectAnchor.current, e.runKey);
        }
      }),
    [ctl],
  );

  /* ---------- sending ---------- */
  const readOnlyMessage = useCallback(
    (code: BotsReadOnly) =>
      code === 'agent_unavailable' && owner
        ? tNow('bots.thread.readOnlyShared', { name: owner.name })
        : code !== 'group_closed' && owner
          ? tNow('bots.thread.readOnlyDm', { name: owner.name })
          : tNow('bots.thread.readOnlyClosed'),
    [owner],
  );
  /** Every send goes through here: where the transcript moves, and what a refusal says. */
  const dispatchSend = useCallback(
    async (body: SendInput, via: 'composer' | 'card'): Promise<SendOutcome> => {
      const keyboardUp = Keyboard.isVisible();
      if (roomRef.current && body.mentions.length === 0) {
        // A room, and no Agent asked: people talking, Messages-style — the keyboard stays, the end
        // stays in view and the bubble lands there (no reply is coming to unfold below it).
        landOnEnd();
      } else if (!snapRef.current.runActive) {
        // The conversation's turn: the keyboard goes down and the bubble slides under the bar once it
        // is in the list; the replies unfold below it — the view never follows them.
        if (keyboardUp) {
          holdForTurn();
          Keyboard.dismiss();
        }
        expectAnchor.current = { kind: 'pending' };
      } else if (keyboardUp && via === 'composer') {
        // Sent while Bots work: queued in place, no re-anchoring — just the keyboard out of the way.
        Keyboard.dismiss();
      }
      const outcome = await ctl.send(body);
      if (outcome.ok || outcome.kind === 'not_delivered') return outcome;
      if (expectAnchor.current?.kind === 'pending') expectAnchor.current = null;
      cancelTurn();
      if (outcome.kind === 'read_only') alertError(readOnlyMessage(outcome.code));
      else alertError(tNow('bots.thread.sendFailed'), outcome.message || undefined);
      return outcome;
    },
    [ctl, holdForTurn, cancelTurn, landOnEnd, readOnlyMessage],
  );

  /* ---------- a task chat: edit the last message / answer it again (D23) ---------- */
  const rewind = useMemo(
    () =>
      rewindTarget({
        kind: conversation?.kind ?? null,
        messages: snap.messages,
        readOnly,
        busy: snap.runActive || snap.pending.length > 0 || snap.load !== 'ready',
      }),
    [conversation?.kind, snap.messages, readOnly, snap.runActive, snap.pending.length, snap.load],
  );
  const rewindRef = useRef(rewind);
  rewindRef.current = rewind;
  /** Every rewind goes through here: the turn is anchored like a send's, a refusal is explained. */
  const dispatchRewind = useCallback(
    async (body: RewindInput): Promise<RewindOutcome> => {
      if (Keyboard.isVisible()) {
        holdForTurn();
        Keyboard.dismiss();
      }
      const going = ctl.rewind(body);
      // The member message stays where it is (everything after it goes): the reply unfolds under it.
      anchorTo(body.messageId);
      const outcome = await going;
      if (outcome.ok) return outcome;
      cancelTurn();
      const edit = body.content !== undefined;
      if (outcome.kind === 'read_only') alertError(readOnlyMessage(outcome.code));
      else if (outcome.kind === 'busy') alertError(tNow('bots.thread.rewindBusy'));
      else {
        const key = outcome.kind === 'rejected' ? rewindRefusalKey(outcome.code) : null;
        alertError(
          tNow(edit ? 'bots.thread.editFailed' : 'bots.thread.rewindFailed'),
          key ? tNow(key) : outcome.kind === 'rejected' ? outcome.message || undefined : tNow('bots.card.err.network'),
        );
      }
      return outcome;
    },
    [ctl, holdForTurn, cancelTurn, anchorTo, readOnlyMessage],
  );
  const regenerate = useCallback(() => {
    const target = rewindRef.current;
    if (target) void dispatchRewind({ messageId: target.memberId });
  }, [dispatchRewind]);
  /** Put the message's text in the composer; what it held waits for Cancel (or the sent edit). */
  const startEdit = useCallback(
    (messageId: string) => {
      const target = rewindRef.current;
      const message = snapRef.current.messages.find((m) => m.id === messageId);
      if (!target || target.memberId !== messageId || !target.editable || !message) return;
      const held = editingRef.current?.held ?? take();
      setEditing({ messageId, original: message.content, held });
      setInput(splitAttachments(message.content).text);
      focusInput();
    },
    [take, setInput, focusInput],
  );
  const cancelEdit = useCallback(() => {
    const current = editingRef.current;
    if (!current) return;
    setEditing(null);
    setInput('');
    inputRef.current?.clear();
    giveBack(current.held);
  }, [setInput, giveBack]);
  // The message is no longer the last one (another message landed meanwhile): no edit to send —
  // its text stays in the composer (sendable as a new message), what it held before comes back.
  useEffect(() => {
    if (!editing || !rewind || rewind.memberId === editing.messageId) return;
    setEditing(null);
    giveBack(editing.held);
  }, [editing, rewind, giveBack]);
  // Leaving mid-edit: the thread's draft is what the composer held before the edit (an unsent edit
  // would come back as a plain draft — a new message — next time).
  useEffect(
    () => () => {
      const current = editingRef.current;
      if (current) saveDraft(sessionId, current.held);
    },
    [sessionId],
  );
  /** Send while editing: the edited text (quotes before it, the message's files kept) answered again. */
  const sendEdit = useCallback(
    async (current: { messageId: string; original: string; held: ThreadDraft }) => {
      const text = input.trim();
      if (!text) return;
      if (!rewindRef.current || rewindRef.current.memberId !== current.messageId) {
        alertError(tNow(rewindRef.current ? 'bots.thread.rewindNotLast' : 'bots.thread.rewindBusy'));
        return;
      }
      const quote = annotations.length ? annotations.map((a) => a.text).join('\n') : null;
      const sent = take();
      inputRef.current?.clear();
      const outcome = await dispatchRewind({
        messageId: current.messageId,
        content: editedContent(current.original, quote ? `${quote}\n\n${text}` : text),
      });
      if (outcome.ok) {
        setEditing(null);
        giveBack(current.held);
      } else giveBack(sent);
    },
    [input, annotations, take, giveBack, dispatchRewind],
  );

  /* ---------- a new chat's first message (the new-chat screen created this task chat) ---------- */
  useEffect(() => {
    const first = takeFirstSend(sessionId);
    if (!first) return;
    void dispatchSend(first.input, 'composer').then((outcome) => {
      // Refused: the words come back to the composer (a "Not Delivered" bubble keeps them itself).
      if (!outcome.ok && (outcome.kind === 'read_only' || outcome.kind === 'rejected')) {
        giveBack({ text: first.input.text, images: first.images });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the thread opens
  }, [sessionId]);

  const membersRef = useRef(members);
  membersRef.current = members;
  const send = useCallback(async () => {
    const current = editingRef.current;
    if (current) {
      await sendEdit(current);
      return;
    }
    const text = input.trim();
    const uploaded = images.filter((im) => im.status === 'done' && im.remote);
    // Send stays disabled while a picked image is still uploading (see Composer).
    if ((!text && !uploaded.length) || images.some((im) => im.status === 'uploading')) return;
    const quote = annotations.length ? annotations.map((a) => a.text).join('\n') : null;
    const held = take();
    // Clear natively too: a multiline field emptied only through `value` keeps its grown height (Fabric).
    inputRef.current?.clear();
    const outcome = await dispatchSend(
      {
        text: quote ? `${quote}\n\n${text}` : text,
        images: uploaded.map((im) => im.remote!),
        // what the member typed — a quote doesn't address anyone
        mentions: parseMentions(text, membersRef.current),
      },
      'composer',
    );
    if (!outcome.ok && (outcome.kind === 'read_only' || outcome.kind === 'rejected')) giveBack(held);
  }, [input, images, annotations, take, giveBack, dispatchSend, sendEdit]);

  /** An answer from a card in a Bot's reply, addressed back to that Bot (D22). Resolves false if it didn't go. */
  const onReplyAs = useCallback(
    async (botId: string | null, text: string) => {
      const outcome = await dispatchSend({ text, images: [], mentions: botId ? [botId] : [] }, 'card');
      return outcome.ok || outcome.kind === 'not_delivered';
    },
    [dispatchSend],
  );

  /** One tap on Retry / Continue / Ask Again: an honest new member message ("@Name Please try that again."). */
  const address = useCallback(
    (botId: string | null, line: 'retry' | 'continue') => {
      const bot = botId ? lookupRef.current(botId) : undefined;
      const text = tNow(line === 'retry' ? 'bots.thread.retryMessage' : 'bots.thread.continueMessage');
      void dispatchSend(
        { text: bot ? `${mentionToken(bot.name)}${text}` : text, images: [], mentions: bot ? [bot.id] : [] },
        'card',
      );
    },
    [dispatchSend],
  );
  const retryBot = useCallback((botId: string) => address(botId, 'retry'), [address]);
  const continueRun = useCallback(() => address(null, 'continue'), [address]);

  const onHandleNow = useCallback(
    async (clientId: string) => {
      if ((await ctl.handleNow(clientId)) === 'refused') alertError(tNow('bots.thread.handleNowFailed'));
    },
    [ctl],
  );
  const onRetryPending = useCallback(
    async (clientId: string) => {
      const content = snapRef.current.pending.find((p) => p.clientId === clientId)?.content ?? '';
      const outcome = await ctl.retry(clientId);
      if (outcome.ok || outcome.kind === 'not_delivered') return;
      // The server refused it this time: the bubble is gone, its words go back to the composer.
      giveBack({ text: content });
      if (outcome.kind === 'read_only') alertError(readOnlyMessage(outcome.code));
      else alertError(tNow('bots.thread.sendFailed'), outcome.message || undefined);
    },
    [ctl, readOnlyMessage, giveBack],
  );
  const onDiscardPending = useCallback((clientId: string) => ctl.discard(clientId), [ctl]);

  /* ---------- mentions ---------- */
  const picker = useMentionPicker({ text: input, members, enabled: !readOnly });
  const selection = useRef<{ start: number; end: number } | null>(null);
  const pickerSelection = picker.onSelectionChange;
  const onSelectionChange = useCallback(
    (sel: { start: number; end: number }) => {
      selection.current = sel;
      pickerSelection(sel);
    },
    [pickerSelection],
  );
  const placeCaret = useCallback((caret: number) => {
    selection.current = { start: caret, end: caret };
    requestAnimationFrame(() => inputRef.current?.setSelection(caret, caret));
  }, []);
  const pickMention = picker.pick;
  /** Mention a member at the caret: completes an `@` token there, else inserts "@Name ". */
  const mention = useCallback(
    (bot: BotView) => {
      selectionTick();
      const completed = pickMention(bot);
      if (completed) {
        setInput(completed.text);
        placeCaret(completed.caret);
        return;
      }
      const at = Math.min(selection.current?.end ?? input.length, input.length);
      const before = input.slice(0, at);
      const glue = before && !/\s$/.test(before) ? ' ' : '';
      const token = mentionToken(bot.name);
      setInput(`${before}${glue}${token}${input.slice(at)}`);
      placeCaret(before.length + glue.length + token.length);
      focusInput();
    },
    [pickMention, placeCaret, focusInput, input, setInput],
  );

  /** A room: `+` → Ask an Agent ▸ — the Agents the member may @ here (the token goes in at the caret). */
  const askItems = useMemo(
    () =>
      room && members.length
        ? {
            items: [
              {
                id: 'ask',
                title: t('bots.room.ask'),
                icon: 'at' as const,
                children: members.map((bot) => ({ id: `ask:${bot.id}`, title: bot.name })),
              },
            ],
            onSelect: (id: string) => {
              const bot = membersRef.current.find((candidate) => `ask:${candidate.id}` === id);
              if (bot) mention(bot);
            },
          }
        : undefined,
    [room, members, t, mention],
  );

  /* ---------- the accessory slot: mention strip > stop hint > task dock ---------- */
  const stop = useComposerStop(snap, ctl);
  const softStopping = snap.stopPhase === 'soft' || !!snap.run?.interrupting;
  const { active: activeTasks, refresh: refreshTasks } = useBotTasks(sessionId, {
    // (a room has no background tasks)
    enabled: ready && !readOnly && !room,
    taskRows,
  });
  const accessory = useMemo(() => {
    if (picker.open) {
      return (
        <MentionStrip candidates={picker.candidates} onPick={mention} />
      );
    }
    if (editing) return <EditBar onCancel={cancelEdit} />;
    if (softStopping && stop?.phase === 'soft') return <StopHint />;
    if (activeTasks.length) return <TaskDock active={activeTasks} byId={byId} onChanged={refreshTasks} />;
    return null;
  }, [
    picker.open,
    picker.candidates,
    mention,
    editing,
    cancelEdit,
    softStopping,
    stop?.phase,
    activeTasks,
    byId,
    refreshTasks,
  ]);

  /* ---------- 👍 / 👎 on a public Agent's reply (D38: its owner sees the rating and the note, not the chat) ---------- */
  const rate = useCallback(
    async (messageId: string, rating: 1 | -1) => {
      const message = snapRef.current.messages.find((m) => m.id === messageId);
      const store = useBots.getState();
      if (!rateableReply(message, store.shared) || !message?.bot_id) return;
      // The rating it already has, chosen again: take it back.
      if (store.ratings[messageId] === rating) {
        if (await store.unrateReply(sessionId, messageId)) {
          toast(tNow('bots.thread.rateRemoved'), rating === 1 ? 'thumbUp' : 'thumbDown');
        } else alertError(tNow('bots.thread.rateRemoveFailed'));
        return;
      }
      let comment: string | null = null;
      if (rating === -1) {
        // The note is optional: Skip still sends the 👎.
        comment = await promptText({
          title: tNow('bots.thread.rateTitle'),
          message: tNow('bots.thread.rateMessage', { owner: store.shared[message.bot_id]?.owner.nickname ?? '' }),
          confirmLabel: tNow('bots.thread.rateSend'),
          cancelLabel: tNow('bots.thread.rateSkip'),
        });
      }
      if (await useBots.getState().rateReply(sessionId, messageId, rating, comment)) {
        toast(tNow('bots.thread.rateThanks'), rating === 1 ? 'thumbUp' : 'thumbDown');
      } else alertError(tNow('bots.thread.rateFailed'));
    },
    [sessionId],
  );

  /* ---------- message actions (stable — rows are memoised) ---------- */
  const onAction = useCallback(
    async (msg: ChatMessage, action: MessageAction) => {
      switch (action) {
        case 'copy':
          await Clipboard.setStringAsync(visibleText(msg)).catch(() => {});
          toast(tNow('common.copied'), 'copy');
          break;
        case 'share':
          void Share.share({ message: msg.text });
          break;
        case 'quote':
          addQuotes([excerpt(plainText(msg.text), 120)]);
          focusInput();
          break;
        // a task chat's last message / reply (rows only offer these then)
        case 'edit':
          startEdit(msg.id);
          break;
        case 'regenerate':
          regenerate();
          break;
        // a public Agent's reply (rows only offer these then)
        case 'rateUp':
          void rate(msg.id, 1);
          break;
        case 'rateDown':
          void rate(msg.id, -1);
          break;
      }
    },
    [focusInput, addQuotes, startEdit, regenerate, rate],
  );
  const handlers = useMemo<ReplyHandlers>(
    () => ({
      onOpenTools: (msg) => router.push({ pathname: '/peek/tools', params: { id: openTurn(msg) } }),
      onOpenReasoning: (msg) => router.push({ pathname: '/peek/reasoning', params: { id: openTurn(msg) } }),
      onOpenRefs: (msg) =>
        router.push({
          pathname: '/peek/refs',
          params: { k: putHandoff('refs', { sources: msg.sources, web: msg.web, readOnly: readOnlyNow.current }) },
        }),
      onAction,
    }),
    [router, onAction],
  );
  const onOpenProfile = useCallback(
    (botId: string) => {
      // (a room: another person's own Agent has no profile the member may see)
      if (!useBots.getState().byId[botId]) return;
      router.push({ pathname: '/bots/profile', params: { botId, from: sessionId } });
    },
    [router, sessionId],
  );
  // "Earlier messages were summarized · View": the summary lives in the Bot's profile, Memory tab.
  const ownerIdRef = useRef(owner?.id);
  ownerIdRef.current = owner?.id;
  const onViewSummary = useCallback(() => {
    const botId = ownerIdRef.current;
    if (botId) router.push({ pathname: '/bots/profile', params: { botId, from: sessionId, tab: 'memory' } });
  }, [router, sessionId]);
  const onNewChat = useCallback(() => openNewChat(router), [router]);
  const onRename = useCallback(
    (botId: string) => router.push({ pathname: '/bots/bot-form', params: { botId } }),
    [router],
  );
  const onStarter = useCallback(
    (text: string) => {
      setInput(text);
      focusInput();
    },
    [focusInput, setInput],
  );
  const dismissRunError = useCallback(() => ctl.dismissRunError(), [ctl]);
  const reload = useCallback(() => void ctl.reload(), [ctl]);

  /* ---------- this conversation's computer: its Agent's own (one per Agent, spec 20261011-agent-first-class P3a) ---------- */
  const computerBot = conversationComputer(conversation, (id) => byId[id]);

  /* ---------- header actions (stable; read the latest state via a ref) ---------- */
  const latest = useRef({ owner, displayTitle, conversation, computerBot, sharedOwner, byId, viewerId });
  latest.current = { owner, displayTitle, conversation, computerBot, sharedOwner, byId, viewerId };
  const headerActions = useMemo<ThreadHeaderActions>(
    () => ({
      openDrawer: () => navigation.dispatch(DrawerActions.openDrawer()),
      openComputer: () => {
        const bot = latest.current.computerBot;
        router.push({ pathname: '/bots/computer', params: { c: sessionId, ...(bot ? { bot } : {}) } });
      },
      askInChat: () => {
        const bot = latest.current.owner;
        // (never offered for someone else's Agent: a chat with it is this DM)
        if (bot && !latest.current.sharedOwner) {
          openNewChat(router, { profile: isSproutyBot(bot) ? 'sprouty' : `bot:${bot.id}` });
        }
      },
      // A task chat is a chat in the chats list: tags, rename and delete like one (never share — D26).
      openTags: () => router.push({ pathname: '/sheets/session-tags', params: { sessionId } }),
      rename: async () => {
        const current = latest.current.conversation?.title ?? '';
        const next = await promptText({
          title: tNow('chat.renameTitle'),
          defaultValue: current,
          confirmLabel: tNow('common.save'),
        });
        // (an emptied field answers null: nothing to save)
        if (!next || next === current.trim()) return;
        const result = await updateTaskChat(sessionId, { title: next });
        if (result.ok) void ctl.reload();
        else alertError(tNow('bots.thread.renameFailed'), result.message || undefined);
      },
      remove: async () => {
        const ok = await confirmAction({
          title: tNow('drawer.deleteTitle'),
          message: tNow('chat.deleteHint'),
          confirmLabel: tNow('common.delete'),
          destructive: true,
        });
        if (!ok) return;
        if (snapRef.current.runActive) ctl.stop('hard');
        if (!(await deleteSession(sessionId))) {
          alertError(tNow('chat.deleteFailed'));
          return;
        }
        useBots.getState().dropTaskChat(sessionId);
        openNewChat(router);
        toast(tNow('chat.deleted'), 'trash');
      },
      // ── a room's (P5) ──
      renameRoom: async () => {
        const current = latest.current.conversation?.title ?? '';
        const next = await promptText({
          title: tNow('bots.room.rename'),
          defaultValue: current,
          placeholder: latest.current.displayTitle,
          confirmLabel: tNow('common.save'),
        });
        if (!next || next === current.trim()) return;
        const result = await renameRoom(sessionId, next);
        if (result.ok) {
          void ctl.reload();
          void useBots.getState().loadConversations();
        } else alertError(tNow('bots.room.renameFailed'), result.message || undefined);
      },
      addPeople: () => router.push({ pathname: '/bots/new-room', params: { room: sessionId } }),
      bringAgent: async (botId) => {
        const name = latest.current.byId[botId]?.name ?? '';
        const result = await addRoomAgent(sessionId, botId);
        if (result.ok) {
          void ctl.reload();
          toast(tNow('bots.room.agentAdded', { name }), 'sparkle');
        } else if (result.status === 409) alertError(tNow('bots.room.agentNotForEveryone', { name }));
        else alertError(tNow('bots.room.agentAddFailed', { name }), result.message || undefined);
      },
      removeAgent: async (botId) => {
        const name = latest.current.byId[botId]?.name ?? '';
        const result = await removeRoomAgent(sessionId, botId);
        if (result.ok) {
          void ctl.reload();
          toast(tNow('bots.room.agentRemoved', { name }), 'personMinus');
        } else alertError(tNow('bots.room.agentRemoveFailed', { name }), result.message || undefined);
      },
      leave: async () => {
        const { conversation: here, viewerId: me } = latest.current;
        if (!me) return;
        const ok = await confirmAction({
          title: tNow('bots.room.leaveTitle'),
          message: here && lastOneIn(here, me) ? tNow('bots.room.leaveLast') : tNow('bots.room.leaveMessage'),
          confirmLabel: tNow('bots.room.leaveConfirm'),
          destructive: true,
        });
        if (!ok) return;
        const result = await leaveRoom(sessionId, me);
        if (!result.ok) {
          alertError(
            result.code === 'busy' ? tNow('bots.room.leaveBusy') : tNow('bots.room.leaveFailed'),
            result.code === 'busy' ? undefined : result.message || undefined,
          );
          return;
        }
        useBots.getState().dropConversation(sessionId);
        forgetGoneThread(sessionId);
        openNewChat(router);
        toast(tNow('bots.room.left'), 'logout');
      },
    }),
    [navigation, router, sessionId, ctl],
  );
  /** A room's ⋯ entries — the same object while what they say is the same (the bar is memoised). */
  const roomMenuNow = useMemo<RoomMenu | null>(() => {
    if (!room) return null;
    const ownerId = roomOwnerId(room);
    const name = (botId: string) => byId[botId]?.name ?? t('bots.room.someAgent');
    const everyone = [...(room.participants ?? [])].sort((a, b) =>
      a.user_id === viewerId ? -1 : b.user_id === viewerId ? 1 : 0,
    );
    return {
      people: everyone.map((person) => ({
        id: person.user_id,
        name: person.nickname,
        detail:
          [
            person.user_id === viewerId ? t('bots.room.you') : '',
            person.user_id === ownerId ? t('bots.room.owner') : '',
          ]
            .filter(Boolean)
            .join(t('bots.nav.listSep')) || undefined,
      })),
      agents: [...room.members]
        .sort((a, b) => a.position - b.position)
        .map((member) => {
          const owner = member.owner_user_id ?? '';
          const ownerName = owner === viewerId ? null : personName(room, owner);
          return {
            id: member.bot_id,
            name: name(member.bot_id),
            detail:
              owner === viewerId
                ? t('bots.room.yourAgent')
                : ownerName && !roomDir?.guessed.has(member.bot_id)
                  ? t('bots.room.agentOf', { name: ownerName })
                  : undefined,
          };
        }),
      bringable: bringableAgents(room, ownBots).map((bot) => ({ id: bot.id, name: bot.name })),
      removable: removableAgents(room, viewerId).map((member) => ({ id: member.bot_id, name: name(member.bot_id) })),
    };
  }, [room, byId, viewerId, ownBots, roomDir, t]);
  const roomMenu = useStable(roomMenuNow, roomMenuNow ? JSON.stringify(roomMenuNow) : '');
  const onOpenChat = useCallback((chat: { c: string; title: string }) => openThread(router, chat), [router]);
  // The conversation's Agent's computer, offered on every thread once computers run here; the 🖥 is
  // tinted with its state (only primitives reach the memoised header: no stream-tick re-renders).
  // Someone else's Agent has one only when its owner granted it (the member's own copy) and it is
  // still offered — otherwise its status is never read (the routes answer 404 `agent_not_found`).
  const hasComputer = useBots((s) => s.computer?.state === 'ready') && computerOffered(sharedOwner) && !room;
  const computerName = useBots((s) => computerAgent(s, computerBot)?.name ?? null);
  const computerState = useComputerStatus(hasComputer && focused && !!conversation, computerBot);
  const computerTone = computerButtonTone(computerState.phase);
  const computerLabel = computerName
    ? computerState.phase
      ? t('bots.computer.openOfState', { name: computerName, state: t(phaseLabelKey(computerState.phase)) })
      : t('bots.computer.openOf', { name: computerName })
    : t('bots.computer.open');

  /* ---------- rows ---------- */
  const runActive = snap.runActive;
  const reply: Omit<ReplyRowProps, 'readOnly'> = {
    loaded: botsLoaded,
    memoryStates: snap.memoryStates,
    handlers,
    onReplyAs,
    onOpenProfile,
  };
  const renderRow = (row: ThreadRow): React.ReactNode => {
    switch (row.kind) {
      case 'top':
        return <TopLoader state={snap.earlier} manual={manualEarlier} onLoad={loadEarlierByHand} />;
      case 'intro':
        return (
          <Intro
            kind={kind}
            title={displayTitle}
            owner={owner}
            members={members}
            sharedBy={sharedOwner?.owner.nickname}
            people={people ?? undefined}
            privateChat={privateChat}
          />
        );
      case 'time':
        return <TimeSeparator at={row.at} />;
      case 'user':
        return (
          <UserRow
            message={row.message}
            readOnly={readOnly}
            editable={!!rewind?.editable && rewind.memberId === row.message.id}
            onAction={onAction}
          />
        );
      case 'person':
        return (
          <PersonRow
            message={row.message}
            name={(room && personName(room, row.userId)) || t('bots.room.someone')}
            tint={c[personTint(row.userId)]}
            header={row.header}
            onAction={onAction}
          />
        );
      case 'bot':
        return (
          <ReplyRow
            {...reply}
            readOnly={readOnly || !answerable(row.botId)}
            message={row.message}
            botId={row.botId}
            header={row.header}
            bot={lookup(row.botId)}
            followUp={followUps.get(row.message.id)}
            nameHint={
              row.message.bot_event?.kind === 'greeting' && !group && !readOnly && wantsNameHint(owner)
                ? owner
                : undefined
            }
            onRename={onRename}
            canRegenerate={!!rewind && rewind.replyId === row.message.id}
            onRegenerate={regenerate}
            rating={rateableReply(row.message, shared) ? (ratings[row.message.id] ?? null) : undefined}
          />
        );
      case 'segment': {
        const index = segments.indexOf(row.segment);
        const askedBy = row.segment.reason === 'ask' ? (lookup(row.segment.askedBy)?.name ?? null) : null;
        return (
          <ReplyRow
            {...reply}
            readOnly={readOnly || !answerable(row.segment.botId)}
            segment={row.segment}
            msg={liveMessages[index] ?? fromSegment(row.segment, { id: `${runKey}#${index}`, errorText: '' })}
            header={row.header}
            bot={lookup(row.segment.botId)}
            askedBy={askedBy}
            onRetryBot={retryBot}
          />
        );
      }
      case 'handoff':
        return (
          <HandoffRow
            from={lookup(row.handoff.from)}
            to={lookup(row.handoff.to)}
            toLabel={row.handoff.to}
            brief={row.handoff.text}
          />
        );
      case 'event': {
        const event = row.event;
        if (event?.kind === 'task_report' && row.message.content) {
          return (
            <TaskReport
              message={row.message}
              event={event}
              bot={lookup(event.bot_id)}
              loaded={botsLoaded}
              readOnly={readOnly}
              handlers={handlers}
              onOpenProfile={onOpenProfile}
            />
          );
        }
        return (
          <EventRow
            message={row.message}
            event={event}
            failedBotName={event?.kind === 'turn_error' ? (lookup(event.bot_id)?.name ?? null) : null}
            botName={event?.kind === 'unavailable' ? (lookup(event.bot_id)?.name ?? null) : null}
            // (a room: Retry asks the failed Agent again — only one the member may ask; a bare
            // "Please continue." addresses no one there, so a limit offers nothing)
            canAct={!readOnly && (!room || (event?.kind === 'turn_error' && answerable(event.bot_id)))}
            busy={runActive}
            onRetry={retryBot}
            onContinue={continueRun}
            onViewSummary={onViewSummary}
            onOpenChat={onOpenChat}
          />
        );
      }
      case 'request':
        return (
          <RequestRow
            request={requests.get(row.requestId)}
            fallback={row.message}
            sessionId={sessionId}
            readOnly={readOnly}
            highlighted={highlighted === row.requestId}
            onAskAgain={retryBot}
          />
        );
      case 'pending':
        return (
          <PendingRow
            pending={row.pending as MobilePending}
            // (Handle Now only into the member's own run)
            runActive={runActive && snap.runMine}
            upNext={softStopping}
            onAction={onAction}
            onHandleNow={onHandleNow}
            onRetry={onRetryPending}
            onDiscard={onDiscardPending}
          />
        );
      case 'starters': {
        // Someone else's Agent: its owner made it their own — its template's openers may not fit.
        if (shared[row.botId]) return null;
        const template = botTemplate(lookup(row.botId)?.template_key);
        return <Starters starters={template?.copy[lang].starters ?? NO_STARTERS} onPick={onStarter} />;
      }
      case 'tail':
        return <RunTail runError={snap.runError} onDismissError={dismissRunError} />;
    }
  };

  /* ---------- layout ---------- */
  const stickyOffset = useMemo(() => ({ closed: 0, opened: insets.bottom - space.sm }), [insets.bottom]);
  const jumpKind: 'latest' | 'new' | 'needs' = cardBelow ? 'needs' : hasNew ? 'new' : 'latest';
  const newestSpeaker = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item: TranscriptItem = items[i];
      if (item.kind === 'segment') return item.segment.botId;
      if (item.kind === 'bot') return item.botId;
    }
    return null;
  }, [items]);
  const jumpBot = cardBelow ? lookup(cardBelow.botId) : hasNew ? lookup(newestSpeaker) : undefined;
  const onJump = useCallback(() => {
    const card = cardBelow ? rowGeo.current.get(cardBelow.key) : undefined;
    if (card) scrollRef.current?.scrollTo({ y: Math.max(0, card.y - topPad), animated: true });
    else jumpToLatest();
  }, [cardBelow, scrollRef, topPad, jumpToLatest]);
  const placeholder = composerPlaceholder(t, owner?.name ?? displayTitle, winWidth, typo.body.fontSize * fontScale);

  return (
    <View style={styles.root}>
      <ThreadHeader
        sessionId={sessionId}
        title={displayTitle}
        badge={badge}
        ownerName={owner?.name ?? null}
        canAsk={!group && !!owner && owner.status === 'active' && !sharedOwner}
        hasComputer={hasComputer}
        computerTone={computerTone}
        computerLabel={computerLabel}
        taskChat={task}
        room={roomMenu}
        actions={headerActions}
      />

      {gone ? (
        <View style={[styles.center, { top: headerHeight }]}>
          <EmptyState
            icon={snap.load === 'forbidden' ? 'lock' : 'msgs'}
            title={snap.load === 'forbidden' ? t('bots.thread.unavailable') : t('bots.thread.notFound')}
            action={<NativeButton label={t('bots.thread.backToNewChat')} onPress={onNewChat} />}
            style={styles.stretch}
          />
        </View>
      ) : (
        <>
          <KeyboardChatScrollView
            ref={scrollRef}
            style={styles.scroll}
            contentInsetAdjustmentBehavior="never"
            contentContainerStyle={{ paddingTop: topPad }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            keyboardLiftBehavior="persistent"
            offset={insets.bottom}
            extraContentPadding={extraPad}
            blankSpace={blankSpace}
            maintainVisibleContentPosition={mvcp ? MVCP : undefined}
            scrollEventThrottle={64}
            onLayout={onViewport}
            onScroll={onScroll}
            onScrollBeginDrag={onDragStart}
            onEndVisible={onEndVisible}
            onContentSizeChange={onContentSize}
          >
            {showRows
              ? rows.map((row) => (
                  <View key={row.key} onLayout={rowLayout(row.key)}>
                    {renderRow(row)}
                  </View>
                ))
              : null}
          </KeyboardChatScrollView>

          {!showRows && snap.load === 'loading' ? (
            <LoadingState style={[styles.center, { top: headerHeight, bottom: composerH + composerBottom }]} />
          ) : null}
          {!showRows && snap.load === 'error' ? (
            <View style={[styles.center, { top: headerHeight, bottom: composerH + composerBottom }]}>
              <EmptyState icon="alert" title={t('chat.loadFailed')} onRetry={reload} style={styles.stretch} />
            </View>
          ) : null}

          {/* control layer under the bar: a failed refresh */}
          <View
            style={[styles.topLayer, { top: headerHeight + space.xs }]}
            pointerEvents="box-none"
            onLayout={onTopLayer}
          >
            {snap.refreshFailed && showRows ? (
              <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(140)} style={styles.refreshWrap}>
                <Touchable onPress={reload} pressedStyle={{}} style={styles.refreshHit} accessibilityRole="button">
                  <Glass interactive style={styles.refreshPill}>
                    <Icon name="refresh" size={13} weight="semibold" color={c.secondaryLabel} />
                    <Text style={styles.refreshText}>{t('bots.thread.refreshFailed')}</Text>
                  </Glass>
                </Touchable>
              </Animated.View>
            ) : null}
          </View>

          {/* floating control layer: jump to latest + composer, riding the keyboard */}
          <KeyboardStickyView offset={stickyOffset} style={styles.sticky}>
            {!endVisible && showRows ? (
              <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(140)} style={styles.jumpWrap}>
                <JumpButton kind={jumpKind} bot={jumpBot ?? null} onPress={onJump} />
              </Animated.View>
            ) : null}
            {/* Android: the input row sits on the page surface (Material) — iOS lets content flow under its glass */}
            <View
              style={[
                { paddingBottom: composerBottom },
                Platform.OS === 'android' && { backgroundColor: c.background },
              ]}
            >
              {readOnlyCode ? (
                <ReadOnlyBar onHeight={onComposerHeight} message={readOnlyMessage(readOnlyCode)} />
              ) : (
                <Composer
                  ref={inputRef}
                  value={input}
                  onChangeText={setInput}
                  onSend={send}
                  onAttach={draft.attach}
                  annotations={annotations}
                  onRemoveAnnotation={draft.removeAnnotation}
                  images={images}
                  onRemoveImage={draft.removeImage}
                  maxImages={MAX_IMAGES}
                  attachNote={editing ? t('bots.thread.editNoImages') : undefined}
                  placeholder={placeholder}
                  autoFocus={compose}
                  onHeight={onComposerHeight}
                  stop={stop}
                  accessory={accessory}
                  onSelectionChange={onSelectionChange}
                  menuExtra={askItems}
                />
              )}
            </View>
          </KeyboardStickyView>
        </>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  scroll: { flex: 1 },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  stretch: { alignSelf: 'stretch' },
  topLayer: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: space.xs },
  refreshWrap: { alignItems: 'center' },
  // a HIT-tall touch frame around the drawn pill, its extra height handed back
  refreshHit: { paddingVertical: (HIT - REFRESH_H) / 2, marginVertical: -(HIT - REFRESH_H) / 2 },
  refreshPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    minHeight: REFRESH_H,
    paddingHorizontal: space.md,
    borderRadius: REFRESH_H / 2,
  },
  refreshText: { ...typo.footnote, color: c.secondaryLabel },
  sticky: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  jumpWrap: { position: 'absolute', bottom: '100%', right: space.md, paddingBottom: space.sm },
  // HIT-sized touch frames around the drawn controls (negative margins keep them where they were)
  jumpHitRound: { padding: (HIT - JUMP_H) / 2, margin: -(HIT - JUMP_H) / 2 },
  jumpHitPill: { paddingVertical: (HIT - JUMP_H) / 2, marginVertical: -(HIT - JUMP_H) / 2 },
  jumpPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    minHeight: JUMP_H,
    paddingVertical: space.xs,
    paddingLeft: space.xs + 2,
    paddingRight: space.md,
    borderRadius: radius.full,
  },
  jumpText: { ...typo.subheadline, fontWeight: weight.semibold },
}));

/**
 * The composer's hint, kept to one line beside Stop and Send (a wrapped hint grows the floating
 * composer over the newest reply): "Message Sage", else plain "Message". (Only a live DM has a
 * composer: an old group chat is a closed record.)
 */
function composerPlaceholder(t: ReturnType<typeof useT>, name: string, width: number, fontPt: number): string {
  const hint = t('bots.composer.placeholderDm', { name });
  return hintFits(hint, width, fontPt) ? hint : t('bots.composer.placeholder');
}
