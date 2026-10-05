/**
 * PlantAvatar for React Native — the agent face (spec docs/specs/assets/avatar-proto/final/spec.md
 * §10.8): one plant silhouette + two ink eyes on a tinted disc, rendered from the vendored static
 * builder through SvgXml. State lives in the static string (pose, fold, eyes and the error/sleep
 * colour treatment are SVG attributes), so a state change is just a new string.
 *
 * Motion — RN cannot run the web's CSS, so the two motions mobile needs are Reanimated
 * transforms on the plant layer (the disc stays put and is drawn as the wrapper's background):
 *   - idle at hero size (≥ 80px): breathe, capped at 3 cycles (≈ 15s, WCAG 2.2.2);
 *   - thinking: circumnutation (a slow elliptical nod) while the state lasts.
 * Everything else is static. Reduced motion → static, always.
 */

import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { SvgXml } from 'react-native-svg';
import { useTheme } from '../../theme';
import { forSvgXml, IDLE_CYCLES, LOD_AMP, motionFor, pivotOrigin, type PlantMotion } from './plant-avatar-native';
import { buildPlantAvatarSvg, lodFor, plantPalette } from './plant-avatar-svg';
import { DEFAULT_PLANT, isPlantId, type PlantId, type PlantMood, type PlantStateInput } from './plant-ids';

export interface PlantAvatarProps {
  /** Species; default the built-in Sprouty's 'sprout'. */
  plant?: PlantId;
  /** idle|thinking|speaking|done|error|waiting|sleep or a product alias; default idle. */
  state?: PlantStateInput;
  /** Render size in px (drives level of detail and keyline weight). Default 32. */
  size?: number;
  /** Resting eyes (idle only). */
  mood?: PlantMood;
  /** Tinted backing disc (default true). */
  disc?: boolean;
  /** Default: thinking, or idle at hero size (≥ 80px). Lists pass false. */
  animate?: boolean;
  /** Full localised accessible name; omit when adjacent text already says it (decorative). */
  label?: string;
}

/** Breath curve: cubic-bezier(.37,0,.63,1), inhale 40% / exhale 60% of a 5s cycle. */
const BREATH = Easing.bezier(0.37, 0, 0.63, 1);

export function PlantAvatar({
  plant: plantProp,
  state = 'idle',
  size = 32,
  mood,
  disc = true,
  animate,
  label,
}: PlantAvatarProps) {
  const plant: PlantId = isPlantId(plantProp) ? plantProp : DEFAULT_PLANT;
  const { isDark } = useTheme();
  const theme = isDark ? 'dark' : 'light';
  const reduceMotion = useReducedMotion();
  const motion = reduceMotion ? null : motionFor(state, size, animate);
  // While moving, the disc is the wrapper's background so only the plant breathes / nods.
  const svgDisc = disc && !motion;
  const xml = useMemo(
    () => forSvgXml(buildPlantAvatarSvg({ plant, state, size, theme, mood, disc: svgDisc })),
    [plant, state, size, theme, mood, svgDisc],
  );
  const discColor = disc && motion ? plantPalette(plant, state)[theme].disc : undefined;
  // RN's cross-platform ARIA props (iOS / Android / react-native-web alike).
  const a11y = label
    ? ({ accessible: true, role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const);

  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: discColor }} {...a11y}>
      {motion ? (
        <MotionLayer key={motion} motion={motion} size={size} origin={pivotOrigin(plant, size)}>
          <SvgXml xml={xml} width={size} height={size} />
        </MotionLayer>
      ) : (
        <SvgXml xml={xml} width={size} height={size} />
      )}
    </View>
  );
}

function MotionLayer({
  motion,
  size,
  origin,
  children,
}: {
  motion: PlantMotion;
  size: number;
  origin: [number, number, number];
  children: React.ReactNode;
}) {
  const t = useSharedValue(0);
  const amp = LOD_AMP[lodFor(size)];
  const unit = size / 100; // viewBox unit → px

  useEffect(() => {
    t.value = 0;
    t.value =
      motion === 'breathe'
        ? withRepeat(
            withSequence(
              withTiming(1, { duration: 2000, easing: BREATH }),
              withTiming(0, { duration: 3000, easing: BREATH }),
            ),
            IDLE_CYCLES,
          )
        : // one 3s ellipse = the web's two 1.5s alternating nods a quarter-phase apart
          withRepeat(withTiming(2 * Math.PI, { duration: 3000, easing: Easing.linear }), -1);
    return () => cancelAnimation(t);
  }, [motion, t]);

  const style = useAnimatedStyle(() => {
    if (motion === 'breathe') {
      const b = t.value;
      return {
        transform: [{ translateY: -0.7 * amp * unit * b }, { scaleX: 1 + 0.006 * b }, { scaleY: 1 + 0.02 * amp * b }],
      };
    }
    const p = t.value;
    return {
      transform: [
        { translateX: 1.3 * amp * unit * Math.sin(p) },
        { translateY: (-0.15 - 0.75 * Math.cos(p)) * amp * unit },
        { rotate: `${amp * Math.sin(p)}deg` },
      ],
    };
  });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: origin }, style]}>{children}</Animated.View>
  );
}
