/**
 * Sprouty in the conversation header — the one living face of the page:
 *
 *  - `HeaderTitle` — the navigation bar's title: the sprout at the left of the conversation's
 *    title. Its face follows the page (idle, thinking, writing, done, error, waiting for me), and
 *    when idle it gives a small wiggle now and then, so it feels alive.
 *  - `TalkingAvatar` — while a reply is being written, the sprout leaves the title and glides down
 *    to just below it, larger, as if talking to you; when the reply ends it glides back and the
 *    title's sprout takes over again. It never takes touches and lives only while it is out.
 *  - `TalkingBand` and `TalkingRoom` — while it is out the header grows to hold it: a band of the
 *    page's background extends the bar down to below the sprout (content scrolls under it as
 *    under the bar), and the list's top grows by the same room, so a short conversation moves
 *    down instead of sitting under the sprout. Both follow the glide, out and back.
 *
 * The two share one anchor (where the title's sprout is on screen, measured in window
 * coordinates) and one progress value (react-native-reanimated, on the UI thread). Reduce Motion:
 * no glide and no wiggle — the two faces cross-fade in place.
 */

import React, { useEffect, useRef, useState } from 'react';
import { LayoutAnimation, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { create } from 'zustand';
import { useT } from '../lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { AssistantAvatar } from '../ui/avatar';
import type { PlantState } from '../ui/plant-avatar/plant-ids';

/** The title's sprout. */
export const SMALL = 24;
/** The talking sprout below the title. */
export const LARGE = 56;
const GLIDE_MS = 520;
/** How long a reply must stay finished before the sprout glides back. */
const SETTLE_MS = 900;
/** What the header grows by while the sprout is out: the sprout and a gap above and below. */
export const ROOM = LARGE + space.sm * 2;

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the title's sprout and the title are on screen (window coordinates). */
const useAnchor = create<{
  avatar: Frame | null;
  title: Frame | null;
  set: (patch: { avatar?: Frame; title?: Frame }) => void;
}>((set) => ({
  avatar: null,
  title: null,
  set: (patch) => set(patch),
}));

const STATE_WORDS = {
  thinking: 'conversation.stateThinking',
  speaking: 'conversation.stateWriting',
  done: 'conversation.stateDone',
  error: 'conversation.stateError',
  waiting: 'conversation.stateWaiting',
} as const;

/** The navigation bar's title: the sprout (hidden while it is out talking) and the title. */
export function HeaderTitle({
  title,
  state,
  away,
}: {
  title: string;
  state: PlantState;
  /** The sprout is out talking (or on its way back): the title keeps only its place. */
  away: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { width } = useWindowDimensions();
  const reduced = useReducedMotion();
  const avatarRef = useRef<View>(null);
  const titleRef = useRef<View>(null);
  const wiggle = useSharedValue(0);

  // idle: a gentle wiggle every 7–12 s
  useEffect(() => {
    if (state !== 'idle' || reduced) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(
        () => {
          wiggle.value = withSequence(
            withTiming(-9, { duration: 140, easing: Easing.out(Easing.quad) }),
            withTiming(7, { duration: 160, easing: Easing.inOut(Easing.quad) }),
            withTiming(-4, { duration: 140, easing: Easing.inOut(Easing.quad) }),
            withTiming(0, { duration: 160, easing: Easing.out(Easing.quad) }),
          );
          next();
        },
        7000 + Math.random() * 5000,
      );
    };
    next();
    return () => {
      clearTimeout(timer);
      cancelAnimation(wiggle);
      wiggle.value = 0;
    };
  }, [state, reduced, wiggle]);

  const avatarStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${wiggle.value}deg` }],
  }));

  const measure = () => {
    avatarRef.current?.measureInWindow((x, y, w, h) =>
      useAnchor.getState().set({ avatar: { x, y, width: w, height: h } }),
    );
    titleRef.current?.measureInWindow((x, y, w, h) =>
      useAnchor.getState().set({ title: { x, y, width: w, height: h } }),
    );
  };

  return (
    <View
      ref={titleRef}
      onLayout={measure}
      style={[styles.titleRow, { maxWidth: width - 208 }]}
      accessible
      accessibilityRole="header"
      accessibilityLabel={title}
    >
      <Animated.View ref={avatarRef} style={[avatarStyle, { opacity: away ? 0 : 1 }]} onLayout={measure}>
        <AssistantAvatar size={SMALL} state={state} animate />
      </Animated.View>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

/**
 * Drives the glide: `talking` sends the sprout out below the title, and back when it ends.
 * Returns the progress value the title and the floating sprout read, and whether it is out.
 */
export function useTalking(talking: boolean): { out: SharedValue<number>; visible: boolean; room: boolean } {
  const out = useSharedValue(0);
  const [visible, setVisible] = useState(false);
  const [room, setRoom] = useState(false);
  const reduced = useReducedMotion();
  // the list's room changes through React layout (LayoutAnimation), never a UI-thread height:
  // a height animated outside React leaves rows React does not re-render at stale positions
  const makeRoom = (open: boolean) => {
    if (!reduced) LayoutAnimation.configureNext(LayoutAnimation.create(GLIDE_MS, 'easeInEaseOut', 'scaleY'));
    setRoom(open);
  };
  useEffect(() => {
    if (talking) {
      setVisible(true);
      makeRoom(true);
      out.value = withTiming(1, { duration: reduced ? 200 : GLIDE_MS, easing: Easing.inOut(Easing.cubic) });
      return;
    }
    // a reply settling (re-read, the moment between stream and save) flickers "not busy": come
    // back only once it has stayed done for a beat, so the sprout never bobs mid-reply
    const timer = setTimeout(() => {
      makeRoom(false);
      out.value = withTiming(0, { duration: reduced ? 200 : GLIDE_MS, easing: Easing.inOut(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(setVisible)(false);
      });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- makeRoom reads only `reduced`
  }, [talking, reduced, out]);
  return { out, visible, room };
}

/** The sprout out below the title while a reply is written (mounted only while out). */
export function TalkingAvatar({
  state,
  out,
  origin,
}: {
  state: PlantState;
  out: SharedValue<number>;
  /** The conversation's frame in the window (beside the sidebar on an iPad); the sprout settles at its centre. */
  origin: { x: number; y: number; width: number };
}) {
  const t = useT();
  const { width } = origin;
  const reduced = useReducedMotion();
  const avatar = useAnchor((s) => s.avatar);
  const title = useAnchor((s) => s.title);
  // from: the title's sprout; to: centred just below the title
  const from = avatar
    ? { x: avatar.x + avatar.width / 2 - origin.x, y: avatar.y + avatar.height / 2 - origin.y }
    : { x: width / 2, y: 80 - origin.y };
  const below = title ? title.y + title.height : 88;
  const to = { x: width / 2, y: below + space.sm + LARGE / 2 - origin.y };
  const style = useAnimatedStyle(() => {
    const p = out.value;
    if (reduced) {
      return { opacity: p, transform: [{ translateX: to.x - LARGE / 2 }, { translateY: to.y - LARGE / 2 }] };
    }
    const scale = SMALL / LARGE + (1 - SMALL / LARGE) * p;
    return {
      opacity: p > 0.001 ? 1 : 0,
      transform: [
        { translateX: from.x + (to.x - from.x) * p - LARGE / 2 },
        // a slight arc: it dips a little further before settling
        { translateY: from.y + (to.y - from.y) * p - LARGE / 2 + Math.sin(p * Math.PI) * space.sm },
        { scale },
      ],
    };
  });
  const words = state in STATE_WORDS ? t(STATE_WORDS[state as keyof typeof STATE_WORDS]) : undefined;
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', left: 0, top: 0, width: LARGE, height: LARGE }, style]}
      accessible={!!words}
      accessibilityLabel={words}
      accessibilityLiveRegion="polite"
    >
      <AssistantAvatar size={LARGE} state={state} animate />
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...typo.headline, fontWeight: weight.semibold, color: c.label, flexShrink: 1 },
}));

/** The header's extension while the sprout is out: the page background from the top of the screen down to below the sprout. */
export function TalkingBand({ out, height }: { out: SharedValue<number>; height: number }) {
  const { colors: c } = useTheme();
  const style = useAnimatedStyle(() => ({ height: height + out.value * ROOM, opacity: Math.min(1, out.value * 2) }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, right: 0, top: 0, backgroundColor: c.background }, style]} />;
}

/** The list's top grows with the header, so its first message starts below the sprout. */
export function TalkingRoom({ open }: { open: boolean }) {
  return <View style={{ height: open ? ROOM : 0 }} />;
}
