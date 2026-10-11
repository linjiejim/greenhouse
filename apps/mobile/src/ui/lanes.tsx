/**
 * Lanes — kanban columns as horizontally snapping lanes, each scrolling its own
 * cards (extracted from the projects board; src/projects/board.tsx is now a thin
 * wrapper, and Tables / app kanban cards use it too). Web drags cards between
 * columns — on touch, moves go through each card's long-press system menu
 * ("Move to"), and a tap opens the card. A lane header may carry a `+` (new
 * item in that lane).
 *
 * Surfaces follow iOS layering: lanes are a `secondaryBackground` well, cards
 * sit on `tertiaryBackground` (white in light, raised gray in dark) — use
 * `useLaneCardStyle()` for a card so every board's cards look alike.
 */

import React from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon, type IconName } from './core';

const LANE_GAP = space.md;

export interface LaneSpec<T> {
  key: string;
  title: string;
  /** Leading glyph (projects: the status symbol). */
  icon?: IconName;
  /** Glyph / dot colour (a system colour or a data colour). */
  color?: ColorValue;
  items: T[];
  /** Shows a `+` in the header (new item in this lane). */
  onAdd?: () => void;
  /** VoiceOver label of the `+`. */
  addLabel?: string;
}

export function Lanes<T>({
  lanes,
  renderItem,
  keyOf,
  bottomInset = 0,
  laneWidth,
  style,
}: {
  lanes: LaneSpec<T>[];
  renderItem: (item: T, lane: LaneSpec<T>) => React.ReactElement;
  keyOf: (item: T) => string;
  /** Space under the lanes (home indicator). */
  bottomInset?: number;
  /** Fixed lane width (default ~78% of the window, ≤ 320pt). */
  laneWidth?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { width } = useWindowDimensions();
  const laneW = laneWidth ?? Math.min(320, Math.round(width * 0.78));

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={laneW + LANE_GAP}
      decelerationRate="fast"
      style={style}
      contentContainerStyle={[styles.lanes, { paddingBottom: Math.max(space.lg, bottomInset) }]}
    >
      {lanes.map((lane) => (
        <View key={lane.key} style={[styles.lane, { width: laneW }]}>
          <View style={styles.laneHeader}>
            {lane.icon ? (
              <Icon name={lane.icon} size={17} color={lane.color ?? c.secondaryLabel} />
            ) : lane.color ? (
              <View style={[styles.dot, { backgroundColor: lane.color }]} />
            ) : null}
            <Text style={styles.laneTitle} numberOfLines={1}>
              {lane.title}
            </Text>
            <Text style={styles.laneCount}>{lane.items.length}</Text>
            {lane.onAdd ? (
              <Pressable
                onPress={lane.onAdd}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={lane.addLabel}
                style={({ pressed }) => [styles.laneAdd, pressed && { opacity: 0.5 }]}
              >
                <Icon name="plus" size={17} weight="semibold" color={c.accent} />
              </Pressable>
            ) : null}
          </View>
          <FlatList
            data={lane.items}
            keyExtractor={keyOf}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.laneBody}
            ListEmptyComponent={<View style={styles.laneEmpty} />}
            renderItem={({ item }) => renderItem(item, lane)}
          />
        </View>
      ))}
    </ScrollView>
  );
}

/** The style of a card inside a lane (pressable wrapper of every board's cards). */
export function useLaneCardStyle() {
  const { colors: c } = useTheme();
  return useStyles(c).card;
}

const useStyles = makeStyles((c) => ({
  lanes: { paddingHorizontal: space.margin, gap: LANE_GAP, flexGrow: 1 },
  lane: { flex: 1, backgroundColor: c.secondaryBackground, borderRadius: radius.xl, ...squircle, overflow: 'hidden' },
  laneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md + 2,
    paddingTop: space.md + 2,
    paddingBottom: space.sm,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  laneTitle: { ...typo.headline, color: c.label, flex: 1 },
  laneCount: {
    ...typo.subheadline,
    fontWeight: weight.semibold,
    color: c.secondaryLabel,
    fontVariant: ['tabular-nums'],
  },
  laneAdd: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', marginRight: -space.xs },
  laneBody: { gap: space.sm, paddingHorizontal: space.sm, paddingBottom: space.xxl, flexGrow: 1 },
  laneEmpty: {
    height: 64,
    marginHorizontal: space.xs,
    borderRadius: radius.lg,
    ...squircle,
    borderWidth: 1.5,
    borderColor: c.separator,
    borderStyle: 'dashed',
  },
  card: {
    backgroundColor: c.tertiaryBackground,
    borderRadius: radius.lg,
    ...squircle,
    paddingHorizontal: space.md,
    paddingVertical: space.md - 2,
    gap: space.xs,
  },
}));
