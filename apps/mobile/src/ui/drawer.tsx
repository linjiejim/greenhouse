/**
 * Native left-drawer building blocks (react-native-drawer-layout via expo-router's
 * `Drawer` layout — see app/(drawer)/_layout.tsx). The navigator owns the panel
 * slide, scrim, and the iOS-style left edge-swipe to open; these are the reusable
 * *pieces* you compose into any drawer:
 *
 *  - `drawerScreenOptions(colors)` — consistent panel chrome (sized panel, surface
 *     background, rounded outer edge, scrim, comfortable left edge-swipe). Spread
 *     into a `Drawer`'s `screenOptions`.
 *  - `DrawerScaffold` — the panel body: account header on top, a scrollable
 *     caller `children` area (e.g. the history list), an optional fixed `footer`
 *     (e.g. 设置), then sign-out + version pinned to the bottom.
 *  - `DrawerRow` — a drawer nav row (leading rounded icon, label, chevron).
 *
 * Reuse: build a `drawerContent` from `DrawerScaffold` + `DrawerRow` and hand
 * `drawerScreenOptions` to the `Drawer`. See src/chat/home-drawer.tsx for the
 * Home wiring; other screens can drop in their own content the same way.
 */

import React from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DrawerNavigationOptions } from 'expo-router/drawer';
import { font, makeStyles, radius, useTheme, type ThemeColors } from '../theme';
import { useT } from '../lib/i18n';
import { Icon, IconName, Touchable } from './core';
import { Tile, UserAvatar } from './widgets';

const { width: SCREEN_W } = Dimensions.get('window');
/** Panel width — capped, but never more than 82% of the screen. */
export const DRAWER_W = Math.min(320, SCREEN_W * 0.82);

/**
 * Consistent native-drawer options: a sized panel on the surface colour with a
 * rounded outer edge, a themed scrim, and a comfortable left edge-swipe zone.
 * Headerless (screens draw their own header). Spread into a `Drawer`'s
 * `screenOptions` so every app drawer looks and opens the same way.
 */
export function drawerScreenOptions(c: ThemeColors): DrawerNavigationOptions {
  return {
    headerShown: false,
    drawerType: 'front',
    drawerPosition: 'left',
    swipeEnabled: true,
    swipeEdgeWidth: 44,
    overlayColor: c.scrim,
    drawerStyle: {
      width: DRAWER_W,
      backgroundColor: c.surface,
      borderTopRightRadius: 22,
      borderBottomRightRadius: 22,
    },
  };
}

/** A drawer nav row — leading rounded icon, label, optional trailing chevron. */
export function DrawerRow({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable onPress={onPress} pressedStyle={{ backgroundColor: c.surfaceMuted }} style={styles.row}>
      <Tile icon={icon} size={34} iconSize={20} tint={danger ? 'danger' : 'accent'} />
      <Text style={[styles.rowLabel, danger && { color: c.danger }]}>{label}</Text>
      {danger ? null : <Icon name="chevR" size={16} color={c.fgFaint} />}
    </Touchable>
  );
}

/**
 * The drawer panel body. Presentational only: account header on top, a
 * caller-provided scrollable `children` area (fills available height), an
 * optional fixed `footer`, then sign-out + version pinned to the bottom. Sits
 * inside the native drawer panel, so it owns padding/safe-area but not the
 * slide/scrim/gesture (those come from `drawerScreenOptions`).
 */
export function DrawerScaffold({
  name,
  email,
  version,
  onLogout,
  children,
  footer,
}: {
  name: string;
  email?: string;
  version?: string;
  onLogout: () => void;
  /** Scrollable middle content (e.g. the history list). Fills available height. */
  children?: React.ReactNode;
  /** Fixed rows just above sign-out (e.g. 设置). */
  footer?: React.ReactNode;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.panel, { paddingTop: insets.top + 16 }]}>
      {/* account header */}
      <View style={styles.account}>
        <UserAvatar size={46} label={name[0]} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={styles.name}>
            {name}
          </Text>
          {email ? (
            <Text numberOfLines={1} style={styles.email}>
              {email}
            </Text>
          ) : null}
        </View>
      </View>

      {/* middle: caller content (history) */}
      <View style={{ flex: 1, minHeight: 0 }}>{children}</View>

      {/* footer rows (e.g. 设置), pinned above sign-out */}
      {footer ? <View style={styles.footerRows}>{footer}</View> : null}

      {/* sign out */}
      <DrawerRow icon="logout" label={t('drawer.logout')} onPress={onLogout} danger />
      {version ? (
        <Text style={[styles.foot, { paddingBottom: insets.bottom + 14 }]}>Greenhouse · v{version}</Text>
      ) : (
        <View style={{ height: insets.bottom + 14 }} />
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  // Panel surface/shape/scrim come from `drawerScreenOptions` (drawerStyle); this
  // is just the transparent body so the rounded surface shows through the edges.
  panel: { flex: 1 },
  account: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hairline,
  },
  name: { fontSize: font.title, fontWeight: '700', color: c.fg },
  email: { fontSize: font.caption, color: c.fgMuted, marginTop: 2 },
  footerRows: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.hairline, paddingTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 11, paddingHorizontal: 16, borderRadius: radius.md },
  rowLabel: { flex: 1, fontSize: font.body, fontWeight: '600', color: c.fg },
  foot: { textAlign: 'center', fontSize: font.caption, color: c.fgFaint, marginTop: 10 },
}));
