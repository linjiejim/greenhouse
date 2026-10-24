/**
 * Chip — one short line on a capsule: a link to an object (accent tone), a site or a file
 * (neutral). Leading icon, the label cut in the middle when it is too long (a file keeps its
 * extension), an optional quiet tail (a size). Tapping opens what it names.
 *
 * `inline` sits inside a line of text (link chips in Markdown): a smaller radius, nudged onto the
 * baseline. Otherwise it meets the touch target (a row of chips under a message).
 */

import React from 'react';
import { Text, View } from 'react-native';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Touchable } from './core';

export function Chip({
  icon,
  label,
  tail,
  tone = 'neutral',
  inline = false,
  onPress,
  accessibilityLabel,
}: {
  icon?: React.ReactNode;
  label: string;
  tail?: string;
  tone?: 'accent' | 'neutral';
  inline?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const body = (
    <Touchable
      onPress={onPress}
      style={[styles.chip, inline ? styles.inline : styles.block, tone === 'accent' ? styles.accent : styles.neutral]}
      accessibilityRole={inline ? 'link' : 'button'}
      accessibilityLabel={accessibilityLabel ?? (tail ? `${label}, ${tail}` : label)}
    >
      {icon}
      <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.label, tone === 'accent' && styles.accentLabel]}>
        {label}
      </Text>
      {tail ? <Text style={styles.tail}>{tail}</Text> : null}
    </Touchable>
  );
  // inside a line of text the chip rides on the baseline like a word
  return inline ? <View style={styles.inlineWrap}>{body}</View> : body;
}

const useStyles = makeStyles((c) => ({
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs, maxWidth: 280, ...squircle },
  block: { minHeight: HIT - space.sm, paddingHorizontal: space.md, borderRadius: radius.md },
  inline: { paddingHorizontal: space.sm, paddingVertical: space.xxs, borderRadius: radius.sm },
  inlineWrap: { maxWidth: 280, transform: [{ translateY: space.xs }] },
  accent: { backgroundColor: c.accentFill },
  neutral: { backgroundColor: c.tertiaryFill },
  label: { ...typo.subheadline, color: c.label, flexShrink: 1 },
  accentLabel: { color: c.accentText, fontWeight: weight.semibold },
  tail: { ...typo.caption1, color: c.secondaryLabel },
}));
