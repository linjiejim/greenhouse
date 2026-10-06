/**
 * Progress indicators for projects — drawn with react-native-svg / plain views
 * because iOS has no system ring. Styled like the system's own (Activity /
 * Reminders): a `tertiaryFill` track, a round-capped stroke in the project's
 * color, the percentage in a tabular caption inside the ring.
 *
 * Colors here must be real strings (`hex.*` or a project's data-driven hex).
 */

import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { radius, typo, useTheme, weight } from '../theme';

export function ProgressRing({
  pct,
  size = 34,
  stroke = 3.5,
  color,
  showLabel = true,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  /** Stroke color (hex). Defaults to the accent. */
  color?: string;
  showLabel?: boolean;
}) {
  const { colors: c, hex } = useTheme();
  const value = Math.max(0, Math.min(100, Math.round(pct)));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: value }}
    >
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={hex.tertiaryFill} strokeWidth={stroke} fill="none" />
        {value > 0 ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color ?? hex.accent}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - value / 100)}
          />
        ) : null}
      </Svg>
      {showLabel ? (
        <Text
          maxFontSizeMultiplier={1.15}
          style={{
            position: 'absolute',
            ...typo.caption2,
            fontWeight: weight.semibold,
            fontVariant: ['tabular-nums'],
            color: c.secondaryLabel,
          }}
        >
          {value}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A thin capsule progress bar (project summary, peek, gantt project bands).
 * `track` overrides the `tertiaryFill` track (the gantt tints it with the
 * project color so a 0% band still reads as the project's span).
 */
export function ProgressBar({
  pct,
  color,
  track,
  height = 6,
}: {
  pct: number;
  color?: string;
  track?: string;
  height?: number;
}) {
  const { colors: c, hex } = useTheme();
  const value = Math.max(0, Math.min(100, pct));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value) }}
      style={{ height, borderRadius: radius.full, backgroundColor: track ?? c.tertiaryFill, overflow: 'hidden' }}
    >
      <View style={{ width: `${value}%`, height, borderRadius: radius.full, backgroundColor: color ?? hex.accent }} />
    </View>
  );
}
