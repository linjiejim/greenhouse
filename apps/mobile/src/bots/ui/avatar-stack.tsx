/**
 * A group's roster as overlapping plant discs (drawer rows, the thread title):
 * the first `max` members, each overlapping the previous by a quarter of its
 * size, then a "+N" chip for the rest — the web's PlantAvatarStack. Always
 * static (a list); decorative (the row prints the title). A ring in the
 * surface colour separates the overlapped discs.
 */

import React from 'react';
import { Text, View, type ColorValue } from 'react-native';
import { makeStyles, space, typo, useTheme, weight } from '../../theme';
import { BotAvatar, type AvatarSource } from './bot-avatar';

/** Ring width around each overlapped disc (pt). */
const RING = 1.5;

export function AvatarStack({
  bots,
  size,
  max = 3,
  ring,
}: {
  /** null = a member the directory has not answered for yet (placeholder disc). */
  bots: Array<AvatarSource | null>;
  size: number;
  max?: number;
  /** The surface behind the stack (default `background`, the drawer's); null = no ring. */
  ring?: ColorValue | null;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const ringColor = ring === undefined ? c.background : ring;
  const overlap = Math.round(size / 4);
  const shown = bots.slice(0, Math.max(1, max));
  const rest = bots.length - shown.length;
  const outer = size + (ringColor ? RING * 2 : 0);
  const ringStyle = ringColor
    ? { borderWidth: RING, borderColor: ringColor, borderRadius: outer / 2, backgroundColor: ringColor }
    : null;
  return (
    <View style={styles.row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {shown.map((bot, index) => (
        <View
          // Members never repeat; a placeholder keeps its slot.
          key={bot?.id ?? `pending-${index}`}
          style={[ringStyle, { zIndex: shown.length - index, marginLeft: index > 0 ? -overlap : 0 }]}
        >
          <BotAvatar bot={bot} size={size} animate={false} />
        </View>
      ))}
      {rest > 0 && (
        <View style={[ringStyle, { marginLeft: -overlap }]}>
          <View style={[styles.more, { minWidth: size, minHeight: size, borderRadius: size / 2 }]}>
            <Text style={styles.moreText}>+{rest}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  row: { flexDirection: 'row', alignItems: 'center' },
  // A fill over the opaque ring surface, so the overlapped disc never shows through.
  more: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xs,
    backgroundColor: c.secondaryFill,
  },
  moreText: { ...typo.caption2, fontWeight: weight.semibold, color: c.secondaryLabel },
}));
