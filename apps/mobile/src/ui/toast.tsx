/**
 * Transient confirmation HUD ("已复制", "已删除") — a small glass capsule that
 * drops in under the status bar and fades out. iOS has no system toast; this
 * mirrors the system's own transient banners (AirPods / copy HUDs). Use it
 * only for *confirming* something the user just did — failures go through
 * `alertError()` (src/ui/dialogs.ts), empty/failed loads go in the screen.
 *
 *   toast(t('common.copied'), 'copy')
 *
 * `<ToastHost />` is mounted once in the root layout. On iOS the HUD renders
 * in a `FullWindowOverlay` (a container added on top of the key window), so a
 * toast fired from inside a form sheet or modal shows *above* it instead of
 * behind the sheet's dimming layer. The overlay only exists while a toast is
 * up (re-mounted per toast), so it always lands above whatever is presented at
 * that moment and never sits over the app otherwise. VoiceOver announces the
 * message (the overlay itself is not focusable).
 */

import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay } from 'react-native-screens';
import { create } from 'zustand';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { Icon, type IconName } from './core';
import { Glass } from './glass';
import { selectionTick } from './haptics';

interface ToastState {
  current: { id: number; message: string; icon?: IconName } | null;
  show: (message: string, icon?: IconName) => void;
  clear: (id: number) => void;
}

let seq = 0;
const useToastStore = create<ToastState>((set) => ({
  current: null,
  show: (message, icon) => set({ current: { id: ++seq, message, icon } }),
  clear: (id) => set((s) => (s.current?.id === id ? { current: null } : s)),
}));

/** Show a short confirmation HUD. Safe to call from anywhere (not a hook). */
export function toast(message: string, icon?: IconName): void {
  selectionTick();
  useToastStore.getState().show(message, icon);
}

type Toast = NonNullable<ToastState['current']>;

const EXIT_MS = 200;

export function ToastHost() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const insets = useSafeAreaInsets();
  const current = useToastStore((s) => s.current);
  const clear = useToastStore((s) => s.clear);
  // The toast whose overlay is mounted — outlives `current` by the exit fade.
  const [shown, setShown] = useState<Toast | null>(null);

  useEffect(() => {
    if (!current) return;
    const id = current.id;
    AccessibilityInfo.announceForAccessibility(current.message);
    const timer = setTimeout(() => clear(id), 1800);
    return () => clearTimeout(timer);
  }, [current, clear]);

  useEffect(() => {
    if (current) {
      setShown(current);
      return;
    }
    const timer = setTimeout(() => setShown(null), EXIT_MS + 60);
    return () => clearTimeout(timer);
  }, [current]);

  if (!shown) return null;

  const hud = (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { paddingTop: insets.top + space.xs, alignItems: 'center' }]}
    >
      {current ? (
        <Animated.View key={current.id} entering={FadeInUp.duration(220)} exiting={FadeOutUp.duration(EXIT_MS)}>
          <Glass style={styles.pill}>
            {current.icon ? <Icon name={current.icon} size={16} weight="semibold" color={c.label} /> : null}
            <Text style={styles.text} numberOfLines={2}>
              {current.message}
            </Text>
          </Glass>
        </Animated.View>
      ) : null}
    </View>
  );

  if (Platform.OS !== 'ios') return hud;
  // keyed per toast: a fresh overlay is added on top of the window each time,
  // above any sheet presented since the previous one
  return (
    <FullWindowOverlay key={shown.id} unstable_accessibilityContainerViewIsModal={false}>
      {hud}
    </FullWindowOverlay>
  );
}

const useStyles = makeStyles((c) => ({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md - 2,
    borderRadius: 999,
    maxWidth: 320,
  },
  text: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
}));
