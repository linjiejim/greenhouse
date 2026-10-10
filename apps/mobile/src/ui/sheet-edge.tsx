/**
 * The soft bottom edge of a form sheet at a partial height (iOS 26).
 *
 * At a partial detent the sheet floats: a gap under its rounded bottom edge
 * shows the dimmed page behind — usually a transcript — so a line of the
 * sheet's text cut by that edge sits right above a line of the page's, and the
 * two read as one. The sheet's last stretch fades into its glass instead, like
 * the scroll-edge effect UIKit draws under a bar. At full height the sheet is
 * opaque and reaches the screen's bottom: no fade.
 *
 * Every partial-detent form sheet of the root stack gets it through
 * `sheetEdgeLayout` (the stack's `screenLayout`, app/_layout.tsx) — sheets
 * never render it themselves. Nothing is pinned to the bottom of those sheets,
 * so the fade only ever covers scrolling content (it takes no touches).
 */

import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { NativeStackNavigationOptions } from 'expo-router/build/react-navigation/native-stack';
import { useTheme } from '../theme';

/** What the sheet's glass resolves to over the dimmed app (sampled on iOS 26), as `r, g, b`. */
const GLASS_RGB = { light: '230, 230, 230', dark: '33, 33, 33' } as const;
const FADE_HEIGHT = 32;

interface DetentEvents {
  addListener(type: 'sheetDetentChange', listener: (e: { data?: { index: number } }) => void): () => void;
}

/** `screenLayout` for the root stack: partial-detent form sheets get the soft bottom edge. */
export function sheetEdgeLayout({
  children,
  navigation,
  options,
}: {
  children: React.ReactElement;
  navigation: unknown;
  options: NativeStackNavigationOptions;
}): React.ReactElement {
  const detents = options.sheetAllowedDetents;
  if (Platform.OS !== 'ios' || options.presentation !== 'formSheet' || !Array.isArray(detents)) return children;
  if (!detents.some((d) => d < 1)) return children;
  const initial = typeof options.sheetInitialDetentIndex === 'number' ? options.sheetInitialDetentIndex : detents.length - 1;
  return (
    <SheetEdge navigation={navigation as DetentEvents} detents={detents} initial={initial}>
      {children}
    </SheetEdge>
  );
}

function SheetEdge({
  children,
  navigation,
  detents,
  initial,
}: {
  children: React.ReactElement;
  navigation: DetentEvents;
  detents: number[];
  initial: number;
}) {
  const { isDark } = useTheme();
  const [index, setIndex] = useState(initial);

  useEffect(
    () =>
      navigation.addListener('sheetDetentChange', (e) => {
        if (typeof e.data?.index === 'number') setIndex(e.data.index);
      }),
    [navigation],
  );

  const partial = (detents[index] ?? 1) < 1;
  const rgb = isDark ? GLASS_RGB.dark : GLASS_RGB.light;
  return (
    <View style={styles.fill}>
      {children}
      {partial ? (
        <View
          pointerEvents="none"
          style={[
            styles.fade,
            { experimental_backgroundImage: `linear-gradient(to bottom, rgba(${rgb}, 0), rgba(${rgb}, 0.7) 55%, rgba(${rgb}, 1))` },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: FADE_HEIGHT },
});
