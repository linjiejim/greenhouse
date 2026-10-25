/**
 * Home's greeting sprout (Sprouty's one presence on home): it waves when home opens, and every
 * tap answers at once with a light tap, a squash-and-bounce from its feet and the next face (a
 * happy hop, a wave, a chatter; src/data/home.ts `tapSprout`), then rests. Quick taps make the
 * easter egg: a happy spin with a burst of sparkles and a success haptic. Each reaction is under
 * a second; with Reduce Motion only the face changes (the plant itself snaps).
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { NO_SPROUT_TAPS, SPROUT_REACTION_MS, tapSprout, type SproutReaction } from '../data/home';
import { useTheme } from '../theme';
import { AssistantAvatar } from './avatar';
import { Icon, Touchable } from './core';
import { notifySuccess, tapLight } from './haptics';

const SQUASH_MS = 70;
const SPIN_MS = 720;
const BOUNCE = { damping: 7, stiffness: 340, mass: 0.6 } as const;
const SPARKLES = [-80, -35, 10, 55, 100];

export function GreetingSprout({
  size,
  accessibilityLabel,
  style,
}: {
  size: number;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const [face, setFace] = useState<SproutReaction | 'idle'>('hello');
  const [burst, setBurst] = useState(0);
  const taps = useRef(NO_SPROUT_TAPS);
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null);
  const squashX = useSharedValue(1);
  const squashY = useSharedValue(1);
  const lift = useSharedValue(0);
  const spin = useSharedValue(0);
  const sparkle = useSharedValue(1);

  useEffect(
    () => () => {
      if (rest.current) clearTimeout(rest.current);
    },
    [],
  );

  const onPress = () => {
    const next = tapSprout(taps.current, Date.now());
    taps.current = next.taps;
    setFace(next.reaction);
    if (rest.current) clearTimeout(rest.current);
    rest.current = setTimeout(() => setFace('idle'), SPROUT_REACTION_MS);
    if (next.egg) notifySuccess();
    else tapLight();
    if (reduced) return;
    // squash down onto its feet, then spring up a little and settle
    squashY.value = withSequence(withTiming(0.86, { duration: SQUASH_MS }), withSpring(1, BOUNCE));
    squashX.value = withSequence(withTiming(1.1, { duration: SQUASH_MS }), withSpring(1, BOUNCE));
    lift.value = withSequence(
      withTiming(0, { duration: SQUASH_MS }),
      withTiming(-size * 0.08, { duration: 130, easing: Easing.out(Easing.quad) }),
      withSpring(0, BOUNCE),
    );
    if (next.egg) {
      spin.value = withSequence(withTiming(0, { duration: 0 }), withTiming(360, { duration: SPIN_MS, easing: Easing.out(Easing.cubic) }));
      sparkle.value = withSequence(withTiming(0, { duration: 0 }), withTiming(1, { duration: SPIN_MS, easing: Easing.out(Easing.quad) }));
      setBurst((n) => n + 1);
    }
  };

  // the spin turns about its middle; the squash presses down onto its feet
  const turn = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }, { rotate: `${spin.value}deg` }] }));
  const squash = useAnimatedStyle(() => ({ transform: [{ scaleX: squashX.value }, { scaleY: squashY.value }] }));

  return (
    <Touchable
      onPress={onPress}
      pressedStyle={{}}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={style}
    >
      <Animated.View style={[{ width: size, height: size }, turn]}>
        <Animated.View style={[styles.feet, squash]}>
          <AssistantAvatar size={size} state={face} animate />
        </Animated.View>
      </Animated.View>
      {burst > 0 && !reduced ? <Sparkles key={burst} size={size} progress={sparkle} /> : null}
    </Touchable>
  );
}

/** The easter egg's sparkles: they fly out from behind the sprout's head and fade. */
function Sparkles({ size, progress }: { size: number; progress: SharedValue<number> }) {
  const { colors: c } = useTheme();
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
      {SPARKLES.map((angle, i) => (
        <Sparkle key={angle} angle={angle} distance={size * (0.62 + (i % 2) * 0.12)} progress={progress} color={i % 2 ? c.yellow : c.accent} />
      ))}
    </View>
  );
}

function Sparkle({
  angle,
  distance,
  progress,
  color,
}: {
  angle: number;
  distance: number;
  progress: SharedValue<number>;
  color: ColorValue;
}) {
  const rad = ((angle - 90) * Math.PI) / 180;
  const style = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      opacity: p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85,
      transform: [
        { translateX: Math.cos(rad) * distance * p },
        { translateY: Math.sin(rad) * distance * p },
        { scale: 0.5 + p * 0.6 },
      ],
    };
  });
  return (
    <Animated.View style={[styles.sparkle, style]}>
      <Icon name="sparkle" size={14} color={color} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  sparkle: { position: 'absolute' },
  feet: { transformOrigin: 'bottom' },
});
