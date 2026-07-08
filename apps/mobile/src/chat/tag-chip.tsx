/**
 * TagChip — a session-tag pill: leading color dot + name, optional remove ✕.
 * Colored inline from the tag's own hex (fill 12% / border 25% / dot+text
 * solid), so it looks identical in light and dark, matching the web TagBadge.
 * `size="sm"` is the compact variant for dense rows (history list).
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SessionTag } from '../shared/greenhouse-types';
import { DEFAULT_TAG_COLOR, withAlpha } from '../lib/tag-colors';
import { font, radius } from '../theme';
import { Icon, Touchable } from '../ui';

export function TagChip({ tag, onRemove, size = 'md' }: { tag: SessionTag; onRemove?: () => void; size?: 'sm' | 'md' }) {
  const color = tag.color || DEFAULT_TAG_COLOR;
  const sm = size === 'sm';
  return (
    <View
      style={[
        styles.chip,
        sm && styles.chipSm,
        { backgroundColor: withAlpha(color, '20'), borderColor: withAlpha(color, '40') },
      ]}
    >
      <View style={[styles.dot, sm && styles.dotSm, { backgroundColor: color }]} />
      <Text numberOfLines={1} style={[styles.name, { color }]}>
        {tag.name}
      </Text>
      {onRemove ? (
        <Touchable haptic="none" onPress={onRemove} hitSlop={6} style={styles.remove}>
          <Icon name="x" size={11} color={color} sw={2.4} />
        </Touchable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingVertical: 2,
    paddingHorizontal: 9,
    maxWidth: 150,
  },
  chipSm: { gap: 4, paddingVertical: 1, paddingHorizontal: 7, maxWidth: 88 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotSm: { width: 5, height: 5, borderRadius: 2.5 },
  name: { fontSize: font.caption, fontWeight: '500', flexShrink: 1 },
  remove: { marginLeft: 1 },
});
