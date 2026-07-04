/**
 * TagChip — a session-tag pill: leading color dot + name, optional remove ✕.
 * Colored inline from the tag's own hex (fill 12% / border 25% / dot+text
 * solid), so it looks identical in light and dark, matching the web TagBadge.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SessionTag } from '../shared/greenhouse-types';
import { DEFAULT_TAG_COLOR, withAlpha } from '../lib/tag-colors';
import { font, radius } from '../theme';
import { Icon, Touchable } from '../ui';

export function TagChip({ tag, onRemove }: { tag: SessionTag; onRemove?: () => void }) {
  const color = tag.color || DEFAULT_TAG_COLOR;
  return (
    <View style={[styles.chip, { backgroundColor: withAlpha(color, '20'), borderColor: withAlpha(color, '40') }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
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
  dot: { width: 6, height: 6, borderRadius: 3 },
  name: { fontSize: font.caption, fontWeight: '500', flexShrink: 1 },
  remove: { marginLeft: 1 },
});
