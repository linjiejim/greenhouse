/**
 * TagChip — a session tag as a small capsule: the tag's color dot + name on a
 * faint wash of the same color, optional remove ✕. The tag color is *data*
 * (shared with the web app), so the wash is derived from its hex with theme
 * `alpha()`; the name stays in the system label color so it reads in light
 * and dark at every palette color (colored text fails contrast for yellow).
 */

import React from 'react';
import { Text, View } from 'react-native';
import type { SessionTag } from '../shared/greenhouse-types';
import { tagHex } from '../lib/tag-colors';
import { useT } from '../lib/i18n';
import { alpha, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon, Touchable } from '../ui/core';

export function TagChip({
  tag,
  onRemove,
}: {
  tag: SessionTag;
  /** Shows a trailing ✕ that calls this. */
  onRemove?: () => void;
}) {
  const { colors: c, isDark } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const color = tagHex(tag.color);
  return (
    <View style={[styles.chip, { backgroundColor: alpha(color, isDark ? 0.2 : 0.12) }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text numberOfLines={1} style={styles.name}>
        {tag.name}
      </Text>
      {onRemove ? (
        <Touchable
          onPress={onRemove}
          hitSlop={8}
          style={styles.remove}
          accessibilityRole="button"
          accessibilityLabel={`${t('tags.remove')} ${tag.name}`}
        >
          <Icon name="x" size={9} weight="bold" color={c.secondaryLabel} />
        </Touchable>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 1,
    borderRadius: radius.full,
    paddingVertical: space.xxs + 1,
    paddingHorizontal: space.sm + 1,
    maxWidth: 160,
    ...squircle,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  name: { ...typo.caption1, fontWeight: weight.medium, color: c.label, flexShrink: 1 },
  remove: { marginLeft: 1, padding: 1 },
}));
