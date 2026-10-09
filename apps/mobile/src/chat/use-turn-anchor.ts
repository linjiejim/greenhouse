/**
 * `useTurnAnchor` — the transcript's scrolling rules, shared by the
 * conversation (app/(drawer)/(main)/index.tsx) and the Bots thread
 * (src/bots/thread/thread-screen.tsx). Wire it into a KeyboardChatScrollView
 * (`ref`, `blankSpace`, `onLayout`, `onContentSizeChange`,
 * `onScrollBeginDrag`, `onEndVisible`) and into the row a turn anchors to.
 *
 * Scrolling never chases the stream — pinning the end on every drain tick
 * made a reply judder until it was unreadable (a Bots send with the keyboard
 * up used to "follow to the end", Messages-style; 2026-10 it anchors like
 * every other turn):
 *  - **Land on the end** (`landOnEnd`): opening a transcript keeps its end in
 *    view while the history lays out, until the user drags or a turn anchors.
 *    Only static rows are held this way: a turn that starts streaming is
 *    anchored by the screen (`holdingEnd()` says whether the end is still
 *    held), never followed.
 *  - **Anchor a turn** (`anchorNext(rowId)` — every send, and a reply the
 *    server started while the end was in view): once that row is laid out it
 *    slides up under the nav bar and the reply unfolds below it in place. The
 *    `blankSpace` inset floor keeps that offset reachable while the reply is
 *    short (= anchor offset + viewport − content) and shrinks to 0 as it
 *    grows, so nothing moves; past the fold the reply simply continues below
 *    — the screen offers "New messages ↓", it never scrolls by itself. A row
 *    too tall for the screen keeps its last lines (and room for the reply) in
 *    view instead.
 *  - `jumpToLatest` for the "back to latest" pill (`endVisible` says when the
 *    end is out of view); `shift(Δ)` keeps the bookkeeping right when earlier
 *    rows are prepended above.
 *
 * A send dismisses the keyboard in the conversation: `holdForTurn()` floors
 * the inset at one viewport first so the current offset stays valid while it
 * slides away (the anchor itself starts with the turn, once the new message is
 * in the list — starting it at the send would anchor the previous message and
 * drop the floor, and the next scroll would clamp short), and the anchor
 * lands again after `keyboardDidHide` (the persistent keyboard lift re-pins
 * the scroll offset every frame of the slide). `cancelTurn()` undoes a send
 * that didn't go.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Keyboard, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import type { KeyboardChatScrollView } from 'react-native-keyboard-controller';

export interface TurnAnchor {
  scrollRef: React.RefObject<React.ComponentRef<typeof KeyboardChatScrollView> | null>;
  /** Inset floor under the content (KeyboardChatScrollView `blankSpace`). */
  blankSpace: SharedValue<number>;
  /** The end of the transcript is on screen (else offer "back to latest"). */
  endVisible: boolean;
  /** KeyboardChatScrollView `onEndVisible`. */
  onEndVisible(visible: boolean): void;
  /** KeyboardChatScrollView `onLayout`. */
  onViewport(e: LayoutChangeEvent): void;
  /** KeyboardChatScrollView `onContentSizeChange`. */
  onContentSize(w: number, h: number): void;
  /** KeyboardChatScrollView `onScroll` (optional: tracks the offset — the conversation doesn't need it). */
  onScroll(e: NativeSyntheticEvent<NativeScrollEvent>): void;
  /** KeyboardChatScrollView `onScrollBeginDrag`: the user took over — stop holding the end. */
  onDragStart(): void;
  /** `onLayout` of the row a turn may anchor to (the conversation: its last user message). */
  onAnchorRowLayout(rowId: string, e: LayoutChangeEvent): void;
  /** Anchor the next turn to this row: it slides under the nav bar once laid out, the reply unfolds below. */
  anchorNext(rowId: string): void;
  /** The end is still held from opening (no drag, no anchored turn since). */
  holdingEnd(): boolean;
  /** A send is starting (keyboard about to hide): floor the inset at one viewport, stop holding the end. */
  holdForTurn(): void;
  /** The send didn't go: drop a pending anchor and re-fit the inset. */
  cancelTurn(): void;
  jumpToLatest(): void;
  /** Opening / switching transcripts: hold the end until a drag or a turn. */
  landOnEnd(): void;
  /** `delta` pt of rows were prepended above (scroll compensated by the caller / the native view). */
  shift(delta: number): void;
}

export function useTurnAnchor({
  topPad,
  bottomInset,
}: {
  /** Where an anchored row comes to rest: below the nav bar (header inset + breathing room). */
  topPad: number;
  /** The floating control layer under the transcript (composer + home indicator + gap), read when a turn anchors. */
  bottomInset: () => number;
}): TurnAnchor {
  const scrollRef = useRef<React.ComponentRef<typeof KeyboardChatScrollView>>(null);
  const blankSpace = useSharedValue(0);
  /** Scroll view height, content height, scroll offset, and where the anchor row sits. */
  const geo = useRef({ viewport: 0, content: 0, offset: 0, row: null as { id: string; y: number; h: number } | null });
  /** Keep the end in view while a transcript's history lays out (until a drag or a turn). */
  const pinEndRef = useRef(true);
  /** The anchored turn's scroll offset. */
  const anchorRef = useRef<number | null>(null);
  /** The row the next turn anchors to, once it is laid out (null = none pending). */
  const pendingRef = useRef<string | null>(null);
  const [endVisible, setEndVisible] = useState(true);
  const bottomInsetRef = useRef(bottomInset);
  bottomInsetRef.current = bottomInset;

  /** Exactly the inset that keeps the anchor offset reachable (0 once the turn outgrows the screen). */
  const syncBlank = useCallback(() => {
    const { viewport, content } = geo.current;
    const offset = anchorRef.current;
    blankSpace.value = offset == null ? 0 : Math.max(0, offset + viewport - content);
  }, [blankSpace]);

  const tryAnchor = useCallback(() => {
    const u = geo.current.row;
    if (pendingRef.current == null || !u || u.id !== pendingRef.current || !geo.current.viewport) return;
    pendingRef.current = null;
    // A long message keeps its last lines (and room for the reply) in view:
    // the height a turn can fill without scrolling is between the nav bar and
    // the control layer.
    const room = (geo.current.viewport - topPad - bottomInsetRef.current()) * 0.4;
    const top = u.h > room ? u.y + u.h - room : u.y;
    const offset = Math.max(0, Math.round(top - topPad));
    anchorRef.current = offset;
    syncBlank();
    // Let the new inset land before scrolling into it.
    const go = () => requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: offset, animated: true }));
    go();
    // A send dismisses the keyboard: while it slides away the chat view keeps
    // re-pinning its scroll offset (persistent lift), which cuts this scroll
    // short — land it again once the keyboard is gone.
    if (Keyboard.isVisible()) {
      const sub = Keyboard.addListener('keyboardDidHide', () => {
        sub.remove();
        if (anchorRef.current === offset) go();
      });
      setTimeout(() => sub.remove(), 1500);
    }
  }, [syncBlank, topPad]);

  const anchorNext = useCallback(
    (rowId: string) => {
      pinEndRef.current = false;
      pendingRef.current = rowId;
      tryAnchor();
    },
    [tryAnchor],
  );

  const holdingEnd = useCallback(() => pinEndRef.current, []);

  const holdForTurn = useCallback(() => {
    blankSpace.value = geo.current.viewport;
    pinEndRef.current = false;
  }, [blankSpace]);

  const cancelTurn = useCallback(() => {
    pendingRef.current = null;
    syncBlank();
  }, [syncBlank]);

  const onViewport = useCallback(
    (e: LayoutChangeEvent) => {
      geo.current.viewport = e.nativeEvent.layout.height;
      syncBlank();
      tryAnchor();
    },
    [syncBlank, tryAnchor],
  );
  const onContentSize = useCallback(
    (_w: number, h: number) => {
      geo.current.content = h;
      if (anchorRef.current != null) syncBlank();
      else if (pinEndRef.current) scrollRef.current?.scrollToEnd({ animated: false });
    },
    [syncBlank],
  );
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    geo.current.offset = e.nativeEvent.contentOffset.y;
  }, []);
  const onAnchorRowLayout = useCallback(
    (rowId: string, e: LayoutChangeEvent) => {
      const { y, height } = e.nativeEvent.layout;
      geo.current.row = { id: rowId, y, h: height };
      tryAnchor();
    },
    [tryAnchor],
  );
  const onDragStart = useCallback(() => {
    pinEndRef.current = false;
  }, []);
  const jumpToLatest = useCallback(() => scrollRef.current?.scrollToEnd({ animated: true }), []);

  const landOnEnd = useCallback(() => {
    pinEndRef.current = true;
    anchorRef.current = null;
    pendingRef.current = null;
    geo.current.row = null;
    syncBlank();
  }, [syncBlank]);

  const shift = useCallback(
    (delta: number) => {
      if (!delta) return;
      const g = geo.current;
      g.offset += delta;
      if (g.row) g.row = { ...g.row, y: g.row.y + delta };
      if (anchorRef.current != null) anchorRef.current += delta;
      syncBlank();
    },
    [syncBlank],
  );

  return {
    scrollRef,
    blankSpace,
    endVisible,
    onEndVisible: setEndVisible,
    onViewport,
    onContentSize,
    onScroll,
    onDragStart,
    onAnchorRowLayout,
    anchorNext,
    holdingEnd,
    holdForTurn,
    cancelTurn,
    jumpToLatest,
    landOnEnd,
    shift,
  };
}
