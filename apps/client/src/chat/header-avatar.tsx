/**
 * Sprouty in the conversation header — the one living face of the page:
 *
 *  - `HeaderTitle` — the navigation bar's title view: the sprout at the left, fixed, its face
 *    following the page (idle, thinking, writing, done, error, waiting for me; when idle a small
 *    wiggle now and then, so it feels alive), and beside it the conversation's title over a quiet
 *    line: the agent's name, or while a reply is written what it is doing now (./header-words.ts).
 *  - `HeaderBand` — behind the bar, always: the page's background under the title and a short fade
 *    below it, so a reply scrolling up never shows through the title.
 *
 * Reduce Motion: no wiggle.
 */

import React, { useEffect } from 'react';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { AssistantAvatar } from '../ui/avatar';
import { useFontScaleKey } from '../ui/font-scale';
import type { PlantState } from '../ui/plant-avatar/plant-ids';

/** The title's sprout. */
export const SMALL = 24;

/** The navigation bar's title: the sprout, the title and the quiet line under it. */
export function HeaderTitle({ title, subtitle, state }: { title: string; subtitle: string; state: PlantState }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { width } = useWindowDimensions();
  const fontKey = useFontScaleKey();
  const reduced = useReducedMotion();
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

  return (
    <View style={[styles.titleRow, { maxWidth: width - 208 }]}>
      <Animated.View style={avatarStyle}>
        <AssistantAvatar size={SMALL} state={state} animate />
      </Animated.View>
      <View key={fontKey} style={styles.texts}>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1} accessibilityLiveRegion="polite">
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  texts: { flexShrink: 1, minWidth: 0 },
  title: { ...typo.headline, fontWeight: weight.semibold, color: c.label },
  subtitle: { ...typo.caption1, color: c.secondaryLabel },
}));

const FADE = 14;

/**
 * Behind the bar, always: a band of the page's background under the title and a short fade
 * below it, so a long reply scrolling up never shows through the title. (The list sets its
 * insets by hand, so UIKit's scroll-edge effect does not reach it.)
 */
export function HeaderBand({ height }: { height: number }) {
  const { colors: c, hex } = useTheme();
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0 }}>
      <View style={{ height, backgroundColor: c.background }} />
      <Svg height={FADE} width="100%" accessible={false}>
        <Defs>
          <LinearGradient id="headerFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={hex.background} stopOpacity={1} />
            <Stop offset="1" stopColor={hex.background} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={FADE} fill="url(#headerFade)" />
      </Svg>
    </View>
  );
}
