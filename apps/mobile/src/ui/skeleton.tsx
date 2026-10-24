/**
 * Skeleton — the shape of a list while its first answer is on the way: a card of quiet bars in
 * the rows' geometry, so the screen does not jump when the rows arrive. Static (no shimmer):
 * nothing moves for content that is not there yet. Hidden from VoiceOver, which hears the
 * loading state of the screen instead.
 */

import React from 'react';
import { View } from 'react-native';
import { HIT, makeStyles, radius, space, squircle, useTheme } from '../theme';

export function Skeleton({ rows = 3 }: { rows?: number }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.card} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} style={styles.row}>
          <View style={styles.dot} />
          <View style={[styles.bar, { width: `${70 - ((index * 17) % 30)}%` }]} />
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    marginHorizontal: space.margin,
    paddingVertical: space.xs,
    borderRadius: radius.group,
    backgroundColor: c.secondaryGroupedBackground,
    ...squircle,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: HIT, paddingHorizontal: space.margin },
  dot: { width: space.lg, height: space.lg, borderRadius: radius.xs, backgroundColor: c.quaternaryFill },
  bar: { height: space.md, borderRadius: radius.xs, backgroundColor: c.quaternaryFill },
}));
