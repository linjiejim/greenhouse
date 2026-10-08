/** Haven geometry is generated from the shared brand SVG; no hand-copied paths. */
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../theme';
import { GREENHOUSE_PATHS } from './brand.generated';

export function GreenhouseMark({
  size = 72,
  color,
  animate = false,
}: {
  size?: number;
  color?: string;
  animate?: boolean;
}) {
  const { hex } = useTheme();
  const [motionFinished, setMotionFinished] = useState(false);
  const progress = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!animate) return;
    let alive = true;
    const stop = () => {
      progress.stopAnimation();
      progress.setValue(1);
      if (alive) setMotionFinished(true);
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
        Animated.timing(progress, { toValue: 1, duration: 1300, useNativeDriver: true }).start(({ finished }) => {
          if (alive && finished) setMotionFinished(true);
        });
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
  return (
    <View style={{ width: size, height: size }} accessible accessibilityLabel="Greenhouse">
      {!animate || motionFinished ? (
        <Svg viewBox="0 0 224 224" width={size} height={size} accessible={false}>
          <Path
            d={GREENHOUSE_PATHS.filter(({ id }) => id !== 'seed')
              .map(({ d }) => d)
              .join(' ')}
            fill={markColor}
          />
          <Path d={GREENHOUSE_PATHS[2].d} fill={color ?? GREENHOUSE_PATHS[2].fill} />
        </Svg>
      ) : (
        GREENHOUSE_PATHS.map(({ id, d, fill }) => {
          const seed = id === 'seed';
          return (
            <Animated.View
              key={id}
              style={{
                position: 'absolute',
                width: size,
                height: size,
                opacity: progress.interpolate({
                  inputRange: seed ? [0, 0.35, 1] : [0, 0.65, 1],
                  outputRange: [0, seed ? 0 : 1, 1],
                }),
                transform: seed
                  ? [
                      {
                        scale: progress.interpolate({
                          inputRange: [0, 0.35, 0.9, 1],
                          outputRange: [0.05, 0.05, 1.04, 1],
                        }),
                      },
                    ]
                  : [
                      {
                        translateX: progress.interpolate({
                          inputRange: [0, 0.7, 1],
                          outputRange: [((id === 'house-left' ? -28 : 28) * size) / 224, 0, 0],
                        }),
                      },
                    ],
              }}
            >
              <Svg viewBox="0 0 224 224" width={size} height={size} accessible={false}>
                <Path d={d} fill={seed && !color ? fill : markColor} />
              </Svg>
            </Animated.View>
          );
        })
      )}
    </View>
  );
}
