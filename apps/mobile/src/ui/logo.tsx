/**
 * The Greenhouse V1 mark — the house with a sprout, drawn in strokes and tinted with the accent.
 * Canonical geometry: logos/greenhouse-mark.svg (keep in step if the brand mark changes; the app
 * icon in assets/ is rendered from the same paths). With `animate`, the house appears and the
 * sprout grows (instantly with Reduce Motion); `onBuilt` fires when the mark is whole.
 */

import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { useTheme } from '../theme';

/** How long the mark takes to build itself (the launch splash can leave earlier when content is ready). */
export const MARK_BUILD_MS = 650;

const HOUSE = [
  'M22 104 L22 56 L65 22 L108 56 L108 104 Z',
  'M22 56 L108 56',
  'M44 56 L44 104',
  'M86 56 L86 104',
];
const SPROUT = [
  'M65 104 L65 84',
  'M65 84 C69 78 74 75 76 65 C72 69 67 77 65 84 Z',
  'M65 84 C61 78 56 75 54 65 C58 69 63 77 65 84 Z',
];
const VIEWBOX = '9 7 112 112';

function Strokes({ paths, color, size }: { paths: string[]; color: string; size: number }) {
  return (
    <Svg viewBox={VIEWBOX} width={size} height={size} accessible={false}>
      <G fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round">
        {paths.map((d) => (
          <Path key={d} d={d} />
        ))}
      </G>
    </Svg>
  );
}

export function GreenhouseMark({
  size = 72,
  color,
  animate = false,
  onBuilt,
}: {
  size?: number;
  color?: string;
  animate?: boolean;
  /** `animate`: the mark is whole — built, or static at once with Reduce Motion. */
  onBuilt?: () => void;
}) {
  const { hex } = useTheme();
  const [motionFinished, setMotionFinished] = useState(false);
  const progress = useRef(new Animated.Value(1)).current;
  const onBuiltRef = useRef(onBuilt);
  onBuiltRef.current = onBuilt;
  useEffect(() => {
    if (!animate) return;
    let alive = true;
    const stop = () => {
      progress.stopAnimation();
      progress.setValue(1);
      if (alive) {
        setMotionFinished(true);
        onBuiltRef.current?.();
      }
    };
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (reduced) => {
      if (reduced) stop();
    });
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((reduced) => {
        if (!alive) return;
        if (reduced) {
          stop();
          return;
        }
        progress.setValue(0);
        setMotionFinished(false);
        Animated.timing(progress, { toValue: 1, duration: MARK_BUILD_MS, useNativeDriver: true }).start(
          ({ finished }) => {
            if (!alive || !finished) return;
            setMotionFinished(true);
            onBuiltRef.current?.();
          },
        );
      })
      .catch(() => {
        if (alive) stop();
      });
    return () => {
      alive = false;
      subscription.remove();
      stop();
    };
  }, [animate, progress]);

  const markColor = color ?? hex.accent;
  const still = !animate || motionFinished;
  return (
    <View style={{ width: size, height: size }} accessible accessibilityLabel="Greenhouse">
      {still ? (
        <Strokes paths={[...HOUSE, ...SPROUT]} color={markColor} size={size} />
      ) : (
        <>
          <Animated.View
            style={{
              position: 'absolute',
              opacity: progress.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] }),
              transform: [
                { translateY: progress.interpolate({ inputRange: [0, 0.6, 1], outputRange: [size * 0.06, 0, 0] }) },
              ],
            }}
          >
            <Strokes paths={HOUSE} color={markColor} size={size} />
          </Animated.View>
          <Animated.View
            style={{
              position: 'absolute',
              opacity: progress.interpolate({ inputRange: [0, 0.4, 0.7, 1], outputRange: [0, 0, 1, 1] }),
              transform: [
                { scale: progress.interpolate({ inputRange: [0, 0.4, 0.9, 1], outputRange: [0.2, 0.2, 1.05, 1] }) },
              ],
            }}
          >
            <Strokes paths={SPROUT} color={markColor} size={size} />
          </Animated.View>
        </>
      )}
    </View>
  );
}
