/**
 * MenuDrawer — the left slide-in navigation drawer opened by the Home "☰" burger.
 *
 * Presentational shell only: account header on top, a caller-provided scrollable
 * `children` area in the middle (e.g. the history list), an optional fixed
 * `footer` (e.g. the 设置 row), then sign-out + version pinned to the bottom.
 * Plain RN Animated (translateX panel + scrim fade); plays an exit animation
 * before unmounting so close feels native. Rendered in an RN Modal so it floats
 * above the whole screen (incl. status bar) on both platforms.
 *
 * Use `DrawerRow` for the footer rows so they match the sign-out row styling.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeStyles, radius, shadow, useTheme } from '../theme';
import { useT } from '../lib/i18n';
import { Icon, IconName, Touchable } from './core';
import { UserAvatar } from './widgets';

const { width: SCREEN_W } = Dimensions.get('window');
const PANEL_W = Math.min(320, SCREEN_W * 0.82);

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
      <View style={[styles.rowIcon, danger && { backgroundColor: c.dangerTint }]}>
        <Icon name={icon} size={20} color={danger ? c.danger : c.accentDeep} />
      </View>
      <Text style={[styles.rowLabel, danger && { color: c.danger }]}>{label}</Text>
      {danger ? null : <Icon name="chevR" size={16} color={c.fgFaint} />}
    </Touchable>
  );
}

export function MenuDrawer({
  visible,
  onClose,
  name,
  email,
  version,
  onLogout,
  children,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
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
  const anim = useRef(new Animated.Value(0)).current;
  const [render, setRender] = useState(visible);

  useEffect(() => {
    if (visible) {
      setRender(true);
      Animated.timing(anim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    } else {
      Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setRender(false);
      });
    }
  }, [visible, anim]);

  if (!render) return null;

  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [-PANEL_W, 0] });
  const scrimOpacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <Modal visible transparent statusBarTranslucent navigationBarTranslucent animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        <Animated.View style={[styles.scrim, { opacity: scrimOpacity }]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} />
        </Animated.View>

        <Animated.View
          style={[styles.panel, { width: PANEL_W, paddingTop: insets.top + 16, transform: [{ translateX }] }]}
        >
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
        </Animated.View>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, flexDirection: 'row' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.scrim },
  panel: {
    backgroundColor: c.surface,
    borderTopRightRadius: 22,
    borderBottomRightRadius: 22,
    ...shadow.lift,
  },
  account: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hairline,
  },
  name: { fontSize: 16.5, fontWeight: '700', color: c.fg },
  email: { fontSize: 12.5, color: c.fgMuted, marginTop: 2 },
  footerRows: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.hairline, paddingTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 11, paddingHorizontal: 16, borderRadius: radius.md },
  rowIcon: { width: 34, height: 34, borderRadius: 9, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center' },
  rowLabel: { flex: 1, fontSize: 15.5, fontWeight: '600', color: c.fg },
  foot: { textAlign: 'center', fontSize: 11.5, color: c.fgFaint, marginTop: 10 },
}));
