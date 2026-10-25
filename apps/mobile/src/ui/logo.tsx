/**
 * The Greenhouse mark, Haven: a rounded greenhouse with an arch cut out of its centre and a seed
 * growing in it (logos/README.md). The body takes the palette's `mark` (forest, pale sage in dark
 * mode), the seed its `seed` lime (both from the shared tokens). Geometry comes from ./brand.generated.ts, a generated copy
 * of packages/ui/src/assets/greenhouse-mark.svg on main; never hand-copy the paths. With `animate`,
 * the two sides close in and then the seed grows (static at once with Reduce Motion); `onBuilt`
 * fires when the mark is whole.
 */

import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../theme';
import { GREENHOUSE_PATHS } from './brand.generated';

/** How long the mark takes to build itself (the launch splash can leave earlier when content is ready). */
export const MARK_BUILD_MS = 650;

const VIEWBOX = '0 0 224 224';
const SEED = GREENHOUSE_PATHS.find(({ id }) => id === 'seed')!;
const SIDES = GREENHOUSE_PATHS.filter(({ id }) => id !== 'seed');

export function GreenhouseMark({
  size = 72,
  color,
  animate = false,
  onBuilt,
}: {
  size?: number;
  /** One colour for the whole mark (body and seed), e.g. on a filled tile. */
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

  const body = color ?? hex.mark;
  const seed = color ?? hex.seed;
  const still = !animate || motionFinished;
  return (
    <View style={{ width: size, height: size }} accessible accessibilityLabel="Greenhouse">
      {still ? (
        <Svg viewBox={VIEWBOX} width={size} height={size} accessible={false}>
          {/* both sides in one path: they share a winding, so their overlap stays solid */}
          <Path d={SIDES.map(({ d }) => d).join(' ')} fill={body} />
          <Path d={SEED.d} fill={seed} />
        </Svg>
      ) : (
        GREENHOUSE_PATHS.map(({ id, d }) => {
          const isSeed = id === 'seed';
          return (
            <Animated.View
              key={id}
              style={{
                position: 'absolute',
                width: size,
                height: size,
                opacity: progress.interpolate({
                  inputRange: isSeed ? [0, 0.35, 1] : [0, 0.65, 1],
                  outputRange: [0, isSeed ? 0 : 1, 1],
                }),
                transform: isSeed
                  ? [{ scale: progress.interpolate({ inputRange: [0, 0.35, 0.9, 1], outputRange: [0.05, 0.05, 1.04, 1] }) }]
                  : [
                      {
                        // the sides close in from either hand
                        translateX: progress.interpolate({
                          inputRange: [0, 0.7, 1],
                          outputRange: [((id === 'house-left' ? -28 : 28) * size) / 224, 0, 0],
                        }),
                      },
                    ],
              }}
            >
              <Svg viewBox={VIEWBOX} width={size} height={size} accessible={false}>
                <Path d={d} fill={isSeed ? seed : body} />
              </Svg>
            </Animated.View>
          );
        })
      )}
    </View>
  );
}
