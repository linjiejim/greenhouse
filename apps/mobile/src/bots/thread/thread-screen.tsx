/**
 * `BotThreadScreen` — a Bots conversation as one ongoing thread, rendered on
 * the home route when `?c=<session>` is set (spec
 * docs/specs/20261008-mobile-bots.md §2.5.3). It should feel like a
 * first-party messaging app:
 *
 *  - Chrome (./thread-header.tsx): the title view is the Bot (plant + name +
 *    a live status line — "Browsing github.com", "Waiting for your approval",
 *    its role when idle), ☰ with a badge for the other conversations that need
 *    the member, `⋯` for profile / info / invite / "Ask in a New Chat". No ✎:
 *    a thread is not a session. A "needs you" capsule floats under the bar
 *    for cards elsewhere (`AttentionCapsule`).
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
 *  - Scrolling (`useTurnAnchor`, D10): opening lands on the end. Sending with
 *    the keyboard up keeps it up and scrolls to the end once (Messages);
 *    with it down (a card answer, a starter sent) the turn is anchored like
 *    the conversation's — the bubble slides under the bar, replies unfold
 *    below. A queued send never re-anchors. A run the server started by
 *    itself anchors its first speaker when the end is in view, otherwise the
 *    "New Messages ↓" pill lights up ("Needs You ↓" for a card below). Earlier
 *    pages load near the top, keeping the reading position (D15).
 *  - Effects from the engine: a card arriving in the thread on screen →
 *    warning haptic + one VoiceOver announcement; a Bot starting to reply →
 *    one announcement (never replays, never per token).
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
import { updateConversation } from '../../api/bots';
import { Composer, ReadOnlyBar } from '../../chat/composer';
import { useComposerBridge } from '../../chat/composer-bridge';
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
import { alertError, promptText } from '../../ui/dialogs';
import { EmptyState, LoadingState } from '../../ui/empty';
import { Glass, GlassIconButton } from '../../ui/glass';
import { notifyWarning, selectionTick } from '../../ui/haptics';
import { useHeaderInset } from '../../ui/header-inset';
import type { MenuItem } from '../../ui/menu';
import { toast } from '../../ui/toast';
import { AttentionCapsule } from '../cards/attention-capsule';
import type { MobilePending, SendInput, SendOutcome } from '../contract';
import { forgetThread } from '../last-surface';
import { openNewChat } from '../nav';
import { attentionCount, useBots } from '../store';
import { BotAvatar, type AvatarSource } from '../ui/bot-avatar';
import { useBotThread } from '../use-bot-thread';
import { mentionToken, parseMentions } from '../vendor/mentions';
import { buildTranscript, type TranscriptItem } from '../vendor/transcript';
import { conversationTitle } from '../vendor/web-helpers';
import { fromSegment } from './adapters';
import { threadCache } from './cache';
import { useThreadDraft } from './drafts';
import { MentionStrip } from './mention-strip';
import { EventRow } from './rows/event-row';
import { HandoffRow } from './rows/handoff-row';
import { Intro } from './rows/intro';
import { RunTail } from './rows/run-tail';
import { wantsNameHint } from './rows/sprouty-name';
import { Starters } from './rows/starters';
import { TaskReport } from './rows/task-report';
import {
  BotRow,
  PendingRow,
  RequestRow,
  SegmentRow,
  UserRow,
  type ReplyHandlers,
  type ReplyRowProps,
} from './rows/turns';
import { TimeSeparator } from './rows/time-separator';
import { TopLoader } from './rows/top-loader';
import { statusLine, threadReadOnly, talkingSegment, titlePose } from './status-line';
import { StopHint, useComposerStop } from './stop-control';
import { TaskDock } from './task-dock';
import { dropThreadHeader, publishThreadHeader, ThreadHeader, type ThreadHeaderActions } from './thread-header';
import { threadRows, type ThreadRow } from './thread-rows';
import {
  deepLinkStep,
  expectOnRunSettled,
  expectOnRunStarted,
  prependStep,
  pruneRowGeometry,
  showsFreshPage,
  type ExpectAnchor,
} from './thread-screen-model';
import { useBotTasks } from './use-bot-tasks';
import { useMentionPicker } from './use-mention-picker';

/**
 * D10: a send with the keyboard up keeps it up and scrolls to the end once.
 * The way back if the keyboard-up geometry misbehaves on a device: false =
 * the conversation's behaviour (dismiss, then anchor the turn).
 */
const KEEP_KEYBOARD_ON_SEND = true;
/**
 * D15: how prepended pages keep the reading position — `mvcp` lets the
 * scroll view do it (maintainVisibleContentPosition, on only while a page
 * lands), `delta` scrolls by the height the page added. Flip if MVCP proves
 * unreliable on Fabric (spec V11).
 */
const PREPEND_MODE: 'mvcp' | 'delta' = 'mvcp';
/** Images per message (the web's Bots composer allows the same). */
const MAX_IMAGES = 3;
/** A conversation holds at most this many Bots (POST /api/bots/conversations, the members route). */
const MEMBER_LIMIT = 6;
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
  const headerHeight = useHeaderInset();
  const focused = useIsFocused();

  const { snap, ctl } = useBotThread(sessionId);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const byId = useBots((s) => s.byId);
  const botsLoaded = useBots((s) => s.botsLoaded);
  const badge = useBots((s) => attentionCount(s, sessionId));

  /* ---------- who is here ---------- */
  const conversation = snap.conversation;
  const kind = conversation?.kind ?? 'direct';
  const group = kind === 'group';
  const owner = conversation?.owner_bot_id ? byId[conversation.owner_bot_id] : undefined;
  const memberList = conversation?.members;
  /** Active members in their order (a DM: its Bot and any guests) — mentions, the roster, the lookup by name. */
  const members = useMemo(
    () =>
      memberList
        ? [...memberList]
            .sort((a, b) => a.position - b.position)
            .flatMap((member) => {
              const bot = byId[member.bot_id];
              return bot && bot.status === 'active' ? [bot] : [];
            })
        : NO_BOTS,
    [memberList, byId],
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
  const readOnlyCode = threadReadOnly(snap, byId);
  const readOnly = readOnlyCode != null;
  const directory = useMemo(() => new Map(Object.entries(byId)), [byId]);
  const displayTitle =
    (conversation &&
      conversationTitle(conversation, directory, {
        // Not loaded yet ≠ deleted: keep the placeholder meanwhile.
        unknownBot: botsLoaded ? t('bots.common.deletedBot') : '',
        group: t('bots.thread.group'),
        archived: (name) => `${name} ${t('bots.common.archivedSuffix')}`,
      })) ||
    titleParam;
  const lead = conversation?.lead_bot_id ? byId[conversation.lead_bot_id] : undefined;
  const canInvite =
    !!conversation && (group || readOnlyCode !== 'bot_archived') && conversation.members.length < MEMBER_LIMIT;
  const canInviteRef = useRef(canInvite);
  canInviteRef.current = canInvite;

  /* ---------- a thread that is gone is not reopened on the next cold start (D3; home remembers it) ---------- */
  const gone = snap.load === 'not_found' || snap.load === 'forbidden';
  useEffect(() => {
    if (gone) forgetThread();
  }, [gone]);

  /* ---------- transcript rows ---------- */
  const ready = snap.load === 'ready';
  const showRows = ready || snap.messages.length > 0;
  const segments = snap.run?.segments ?? EMPTY_SEGMENTS;
  const items = useMemo(
    () =>
      buildTranscript({
        messages: snap.messages,
        conversationKind: kind,
        ownerBotId: conversation?.owner_bot_id ?? null,
        segments,
        liveRequests: snap.run?.requests ?? EMPTY_REQUESTS,
        pending: snap.pending,
        requests: snap.requests,
      }),
    [snap.messages, kind, conversation?.owner_bot_id, segments, snap.run?.requests, snap.pending, snap.requests],
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
  const runKey = snap.run?.key ?? '';
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
  const status = statusLine({ snap, byId, kind });
  const statusText = status ? t(status.key, status.vars) : '';
  const pose = titlePose({ snap, byId, kind });
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
    });
  }, [sessionId, displayTitle, statusText, headerBots, pose, group, owner?.id]);
  useEffect(() => () => dropThreadHeader(sessionId), [sessionId]);

  /* ---------- composer state (the draft survives switching threads) ---------- */
  const inputRef = useRef<TextInput>(null);
  const draft = useThreadDraft(sessionId, MAX_IMAGES);
  const { text: input, setText: setInput, images, annotations, take, giveBack, addQuotes } = draft;
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

  /* ---------- the floating layer under the bar: the needs-you capsule, "couldn't refresh" ---------- */
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
    followToEnd,
    holdForTurn,
    cancelTurn,
    jumpToLatest,
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
  // A run the server started by itself: anchor its first speaker (when the end was in view).
  const firstSegmentKey = segments.length ? (items.find((item) => item.kind === 'segment')?.key ?? null) : null;
  useEffect(() => {
    if (expectAnchor.current?.kind !== 'segment' || !firstSegmentKey) return;
    expectAnchor.current = null;
    anchorTo(firstSegmentKey);
  }, [firstSegmentKey, anchorTo]);

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
        row.kind === 'request' && snap.requests.get(row.requestId)?.status === 'pending'
          ? [{ key: row.key, botId: row.botId }]
          : [],
      ),
    [rows, snap.requests],
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
          announced.current.add(e.request.id);
          notifyWarning();
          const name = lookupRef.current(e.request.bot_id)?.name ?? tNow('bots.common.deletedBot');
          AccessibilityInfo.announceForAccessibility(tNow('bots.thread.announceNeedsYou', { name }));
        } else if (e.type === 'run-started') {
          // A run nobody here sent: follow it only if the member is at the end with the keyboard down.
          expectAnchor.current = expectOnRunStarted(expectAnchor.current, e, {
            endVisible: endVisibleRef.current,
            keyboardUp: Keyboard.isVisible(),
          });
        } else if (e.type === 'run-settled') {
          // It never showed a reply: nothing is waiting for one any more.
          expectAnchor.current = expectOnRunSettled(expectAnchor.current, e.runKey);
        }
      }),
    [ctl],
  );

  /* ---------- sending ---------- */
  const readOnlyMessage = useCallback(
    (code: 'bot_archived' | 'no_active_members') =>
      code === 'bot_archived' && owner
        ? tNow('bots.thread.readOnlyDm', { name: owner.name })
        : tNow('bots.thread.readOnlyGroup'),
    [owner],
  );
  const openInvite = useCallback(
    () => router.push({ pathname: '/bots/invite', params: { c: sessionId } }),
    [router, sessionId],
  );

  /** Every send goes through here: where the transcript moves, and what a refusal says. */
  const dispatchSend = useCallback(
    async (body: SendInput, via: 'composer' | 'card'): Promise<SendOutcome> => {
      const keyboardUp = Keyboard.isVisible();
      if (keyboardUp && via === 'composer' && KEEP_KEYBOARD_ON_SEND) {
        // Messages: the keyboard stays, the new bubble is scrolled into view once (over any anchor still waiting).
        expectAnchor.current = null;
        followToEnd();
      } else if (!snapRef.current.runActive) {
        // The conversation's turn: the bubble slides under the bar once it is in the list.
        if (keyboardUp) {
          holdForTurn();
          Keyboard.dismiss();
        }
        expectAnchor.current = { kind: 'pending' };
      }
      // (sent while Bots work: queued in place — no re-anchoring)
      const outcome = await ctl.send(body);
      if (outcome.ok || outcome.kind === 'not_delivered') return outcome;
      if (expectAnchor.current?.kind === 'pending') expectAnchor.current = null;
      cancelTurn();
      if (outcome.kind === 'read_only') {
        if (outcome.code === 'no_active_members' && canInviteRef.current) openInvite();
        else alertError(readOnlyMessage(outcome.code));
      } else alertError(tNow('bots.thread.sendFailed'), outcome.message || undefined);
      return outcome;
    },
    [ctl, followToEnd, holdForTurn, cancelTurn, openInvite, readOnlyMessage],
  );

  const membersRef = useRef(members);
  membersRef.current = members;
  const send = useCallback(async () => {
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
  }, [input, images, annotations, take, giveBack, dispatchSend]);

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
  const menuExtra = useMemo(() => {
    if (!group || readOnly || !members.length) return undefined;
    const menu: MenuItem[] = [
      {
        id: 'mention',
        title: t('bots.composer.mention'),
        icon: 'at',
        children: [
          ...members.map((bot) => ({ id: `mention:${bot.id}`, title: bot.name })),
          ...(canInvite
            ? [{ id: 'mention-invite', title: t('bots.composer.inviteOther'), icon: 'userPlus' as const }]
            : []),
        ],
      },
    ];
    return {
      items: menu,
      onSelect: (id: string) => {
        if (id === 'mention-invite') openInvite();
        else {
          const bot = members.find((m) => `mention:${m.id}` === id);
          if (bot) mention(bot);
        }
      },
    };
  }, [group, readOnly, members, canInvite, t, openInvite, mention]);

  /* ---------- the accessory slot: mention strip > stop hint > task dock ---------- */
  const stop = useComposerStop(snap, ctl);
  const softStopping = snap.stopPhase === 'soft' || !!snap.run?.interrupting;
  const { active: activeTasks, refresh: refreshTasks } = useBotTasks(sessionId, {
    enabled: ready && !readOnly,
    taskRows,
  });
  const accessory = useMemo(() => {
    if (picker.open) {
      return (
        <MentionStrip candidates={picker.candidates} onPick={mention} onInvite={canInvite ? openInvite : undefined} />
      );
    }
    if (softStopping && stop?.phase === 'soft') return <StopHint />;
    if (activeTasks.length) return <TaskDock active={activeTasks} byId={byId} onChanged={refreshTasks} />;
    return null;
  }, [
    picker.open,
    picker.candidates,
    mention,
    canInvite,
    openInvite,
    softStopping,
    stop?.phase,
    activeTasks,
    byId,
    refreshTasks,
  ]);

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
      }
    },
    [focusInput, addQuotes],
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
    (botId: string) => router.push({ pathname: '/bots/profile', params: { botId, from: sessionId } }),
    [router, sessionId],
  );
  const onViewSummary = useCallback(
    () => router.push({ pathname: '/bots/info', params: { c: sessionId } }),
    [router, sessionId],
  );
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

  /* ---------- header actions (stable; read the latest state via a ref) ---------- */
  const latest = useRef({ owner, displayTitle, conversation });
  latest.current = { owner, displayTitle, conversation };
  const headerActions = useMemo<ThreadHeaderActions>(
    () => ({
      openDrawer: () => navigation.dispatch(DrawerActions.openDrawer()),
      profile: () => {
        const bot = latest.current.owner;
        if (bot) onOpenProfile(bot.id);
      },
      info: onViewSummary,
      invite: openInvite,
      askInChat: () => {
        const bot = latest.current.owner;
        if (bot) openNewChat(router, { profile: isSproutyBot(bot) ? 'sprouty' : `bot:${bot.id}` });
      },
      rename: async () => {
        const current = latest.current.conversation?.title?.trim() ?? '';
        const next = await promptText({
          title: tNow('bots.thread.rename'),
          defaultValue: current || latest.current.displayTitle,
          confirmLabel: tNow('common.save'),
        });
        if (!next || next === current) return;
        const res = await updateConversation(sessionId, { title: next });
        if (!res.ok) {
          alertError(tNow('bots.thread.renameFailed'), res.message || undefined);
          return;
        }
        void ctl.reload();
        void useBots.getState().loadConversations();
      },
    }),
    [navigation, onOpenProfile, onViewSummary, openInvite, router, sessionId, ctl],
  );

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
        return <Intro kind={kind} title={displayTitle} owner={owner} members={members} />;
      case 'time':
        return <TimeSeparator at={row.at} />;
      case 'user':
        return <UserRow message={row.message} readOnly={readOnly} onAction={onAction} />;
      case 'bot':
        return (
          <BotRow
            {...reply}
            readOnly={readOnly}
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
          />
        );
      case 'segment': {
        const index = segments.indexOf(row.segment);
        const askedBy = row.segment.reason === 'ask' ? (lookup(row.segment.askedBy)?.name ?? null) : null;
        return (
          <SegmentRow
            {...reply}
            readOnly={readOnly}
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
            canAct={!readOnly}
            busy={runActive}
            onRetry={retryBot}
            onContinue={continueRun}
            onViewSummary={onViewSummary}
          />
        );
      }
      case 'request':
        return (
          <RequestRow
            request={snap.requests.get(row.requestId)}
            fallback={row.message}
            sessionId={sessionId}
            readOnly={readOnly}
            highlighted={highlighted === row.requestId}
            ctl={ctl}
            onAskAgain={retryBot}
          />
        );
      case 'pending':
        return (
          <PendingRow
            pending={row.pending as MobilePending}
            runActive={runActive}
            upNext={softStopping}
            onAction={onAction}
            onHandleNow={onHandleNow}
            onRetry={onRetryPending}
            onDiscard={onDiscardPending}
          />
        );
      case 'starters': {
        const template = botTemplate(lookup(row.botId)?.template_key);
        return <Starters starters={template?.copy[lang].starters ?? NO_STARTERS} onPick={onStarter} />;
      }
      case 'tail':
        return (
          <RunTail
            working={snap.remoteBusy && segments.length === 0}
            bot={group ? (lead ?? members[0] ?? null) : (owner ?? null)}
            runError={snap.runError}
            onDismissError={dismissRunError}
          />
        );
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
  const placeholder = composerPlaceholder(t, group, owner?.name ?? displayTitle);

  return (
    <View style={styles.root}>
      <ThreadHeader
        sessionId={sessionId}
        title={displayTitle}
        badge={badge}
        group={group}
        ownerName={owner?.name ?? null}
        canInvite={canInvite && !gone}
        canAsk={!group && !!owner && owner.status === 'active'}
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

          {/* control layer under the bar: cards elsewhere, a failed refresh */}
          <View
            style={[styles.topLayer, { top: headerHeight + space.xs }]}
            pointerEvents="box-none"
            onLayout={onTopLayer}
          >
            <AttentionCapsule excludeSid={sessionId} />
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
                <ReadOnlyBar
                  onHeight={onComposerHeight}
                  message={readOnlyMessage(readOnlyCode)}
                  action={group && canInvite ? { label: t('bots.thread.invite'), onPress: openInvite } : undefined}
                />
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
                  placeholder={placeholder}
                  autoFocus={compose}
                  onHeight={onComposerHeight}
                  stop={stop}
                  accessory={accessory}
                  onSelectionChange={onSelectionChange}
                  menuExtra={menuExtra}
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

/** Names longer than this leave the placeholder generic: it must fit one line beside the composer's buttons. */
const PLACEHOLDER_NAME_MAX = 12;

/** The composer's hint: "Message Sage" in a DM (plain "Message" for a long name), the @ hint in a group. */
function composerPlaceholder(t: ReturnType<typeof useT>, group: boolean, name: string): string {
  if (group) return t('bots.composer.placeholderGroup');
  return [...name].length > PLACEHOLDER_NAME_MAX
    ? t('bots.composer.placeholder')
    : t('bots.composer.placeholderDm', { name });
}
