/**
 * `ChatCard` — the one frame for cards that sit in a transcript, so a Bot's
 * "needs you" card, an HTML page, a chart and the naming hint read as one
 * family (2026-10: they had four radii and two of them no margin at all — a
 * card's fill ran edge to edge, invisible on the white page in light mode).
 *
 *  - `variant="fill"` — something that waits for the member (a card to
 *    decide, a hint): a tinted fill, no border;
 *  - `variant="outline"` — content (a chart, a page, a file): the page's own
 *    background inside a hairline.
 *  - `inset` — a transcript ROW (a Bots card between replies) keeps the
 *    replies' 16-pt margins; a block inside a reply is already inset by it.
 *  - `onPress` — the whole card is the button (system press highlight); give
 *    it an `accessibilityLabel`, and a trailing chevron in the content.
 *
 * Content layer: solid system colors, never glass (apps/mobile/AGENTS.md).
 */

import React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { makeStyles, radius, space, squircle, useTheme } from '../theme';

export function ChatCard({
  variant = 'outline',
  inset = false,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  style,
  children,
}: {
  variant?: 'fill' | 'outline';
  inset?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const frame = [styles.card, variant === 'fill' ? styles.fill : styles.outline, inset && styles.inset, style];
  if (!onPress) return <View style={frame}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [frame, pressed && { backgroundColor: c.fill }]}
    >
      {children}
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  card: { borderRadius: radius.lg, overflow: 'hidden', ...squircle },
  fill: { backgroundColor: c.tertiaryFill },
  outline: { borderWidth: StyleSheet.hairlineWidth, borderColor: c.separator },
  inset: { marginHorizontal: space.margin },
}));
