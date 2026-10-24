/**
 * iPad split view: on a regular-width iPad (and wide Android tablets) the hub's lists show their
 * item beside them — list on the left, detail on the right — instead of pushing a page. Phones,
 * and an iPad in a narrow Split View or Slide Over, keep the pushed pages. Rules in
 * src/data/split-layout.ts.
 *
 * A detail screen renders through `ScreenChrome`: as a pushed page its title and actions go to
 * the native navigation bar; embedded in a split view they become the pane's own header row.
 */

import React from 'react';
import { Platform, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Stack } from 'expo-router';
import { isSplitWidth, splitListWidth } from '../data/split-layout';
import { HIT, makeStyles, radius, space, typo, useTheme, weight } from '../theme';
import { Icon, type IconName } from './core';
import { EmptyState } from './empty';
import { toolbarIcon } from './toolbar-icon';

/** Whether this screen shows list and detail side by side. */
export function useSplit(): boolean {
  const { width } = useWindowDimensions();
  return isSplitWidth({ os: Platform.OS, isPad: Platform.OS === 'ios' && Platform.isPad, width });
}

export function SplitView({
  list,
  detail,
  placeholder,
}: {
  list: React.ReactNode;
  /** The selected item's detail, or null for the placeholder. */
  detail: React.ReactNode | null;
  placeholder: { icon: IconName; title: string };
}) {
  const { width } = useWindowDimensions();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.row}>
      {/* the large title can only follow a list that is the screen's root; side by side it would stick */}
      <Stack.Screen options={{ headerLargeTitleEnabled: false }} />
      <View style={[styles.list, { width: splitListWidth(width) }]}>{list}</View>
      <View style={styles.detail}>
        {detail ?? <EmptyState icon={placeholder.icon} title={placeholder.title} style={styles.placeholder} />}
      </View>
    </View>
  );
}

export interface ChromeAction {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/** A detail screen's title and actions: the navigation bar when pushed, a header row in a pane. */
export function ScreenChrome({
  title,
  actions = [],
  embedded,
}: {
  title: string;
  actions?: ChromeAction[];
  embedded?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  if (!embedded) {
    return (
      <>
        <Stack.Screen options={{ title }} />
        {actions.length ? (
          <Stack.Toolbar placement="right">
            {actions.map((action) => (
              <Stack.Toolbar.Button
                key={action.label}
                icon={toolbarIcon(action.icon)}
                accessibilityLabel={action.label}
                disabled={action.disabled}
                onPress={action.onPress}
              />
            ))}
          </Stack.Toolbar>
        ) : null}
      </>
    );
  }
  return (
    <View style={styles.paneHeader}>
      <Text style={styles.paneTitle} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          onPress={action.onPress}
          disabled={action.disabled}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          accessibilityState={{ disabled: !!action.disabled }}
          style={({ pressed }) => [styles.paneAction, (pressed || action.disabled) && { opacity: 0.5 }]}
        >
          <Icon name={action.icon} size={20} color={c.accent} />
        </Pressable>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  row: { flex: 1, flexDirection: 'row', backgroundColor: c.groupedBackground },
  list: { borderRightWidth: 0.5, borderRightColor: c.separator },
  detail: { flex: 1, backgroundColor: c.background },
  placeholder: { flex: 1, justifyContent: 'center' },
  paneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.margin + space.xs,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  paneTitle: { ...typo.headline, fontWeight: weight.semibold, color: c.label, flex: 1 },
  paneAction: {
    width: HIT,
    height: HIT,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.secondaryBackground,
  },
}));
