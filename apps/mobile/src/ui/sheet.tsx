/**
 * Bottom-sheet primitives on top of @gorhom/bottom-sheet v5.
 *
 * `Sheet` — controlled (visible/onClose) fixed-height sheet with a grabber,
 *   optional hairline title header and close button. Callers put a
 *   BottomSheetScrollView / BottomSheetView inside for the body.
 * `ActionSheet` — a native-style action menu (long-press / header "⋯") rendered
 *   as a content-sized sheet of rows.
 *
 * The isOpen guard mirrors ai-pen: gorhom dismisses itself on swipe-down / scrim
 * tap and fires onDismiss, so we must not redundantly call dismiss() or the
 * sheet wedges in DISMISSING and won't reopen.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  useBottomSheetTimingConfigs,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { Easing } from 'react-native-reanimated';
import { font, makeStyles, useTheme } from '../theme';
import { Icon, IconName, Touchable } from './core';

/** Snappier than gorhom's default spring — quick, settled open/close. */
function useSheetAnimation() {
  return useBottomSheetTimingConfigs({ duration: 240, easing: Easing.out(Easing.cubic) });
}

export { BottomSheetView, BottomSheetScrollView, BottomSheetTextInput, BottomSheetFlatList } from '@gorhom/bottom-sheet';

function useBackdrop() {
  return useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.34} pressBehavior="close" />
    ),
    [],
  );
}

export function Sheet({
  visible,
  onClose,
  title,
  headerRight,
  heightPct = 88,
  nativeScroll = false,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  headerRight?: React.ReactNode;
  /** sheet height as a % of screen. */
  heightPct?: number;
  /**
   * Set when the body is a plain (native) scrollable list. Disables gorhom's
   * content-panning gesture so the native scroll works (gorhom's scroll
   * coordination is unreliable on this RN/reanimated combo); the sheet is then
   * dragged only via the handle, and dismissed via handle/backdrop/close.
   */
  nativeScroll?: boolean;
  children: React.ReactNode;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const ref = useRef<BottomSheetModal>(null);
  const isOpen = useRef(false);
  const backdrop = useBackdrop();
  const animationConfigs = useSheetAnimation();

  useEffect(() => {
    if (visible && !isOpen.current) {
      isOpen.current = true;
      ref.current?.present();
    } else if (!visible && isOpen.current) {
      isOpen.current = false;
      ref.current?.dismiss();
    }
  }, [visible]);

  const handleDismiss = useCallback(() => {
    isOpen.current = false;
    onClose();
  }, [onClose]);

  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={[`${heightPct}%`]}
      enableDynamicSizing={false}
      enableContentPanningGesture={!nativeScroll}
      animationConfigs={animationConfigs}
      onDismiss={handleDismiss}
      backdropComponent={backdrop}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backgroundStyle={styles.bg}
      handleIndicatorStyle={styles.grabber}
    >
      <View style={{ flex: 1 }}>
        {title ? (
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {headerRight}
              <Touchable onPress={onClose} haptic="none" style={styles.closeBtn}>
                <Icon name="x" size={17} color={c.fgMuted} />
              </Touchable>
            </View>
          </View>
        ) : null}
        {children}
      </View>
    </BottomSheetModal>
  );
}

export interface ActionItem {
  id: string;
  label: string;
  icon: IconName;
  danger?: boolean;
}

export function ActionSheet({
  visible,
  onClose,
  items,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  items: ActionItem[];
  onPick: (id: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const ref = useRef<BottomSheetModal>(null);
  const isOpen = useRef(false);
  const insets = useSafeAreaInsets();
  const backdrop = useBackdrop();
  const animationConfigs = useSheetAnimation();

  useEffect(() => {
    if (visible && !isOpen.current) {
      isOpen.current = true;
      ref.current?.present();
    } else if (!visible && isOpen.current) {
      isOpen.current = false;
      ref.current?.dismiss();
    }
  }, [visible]);

  const handleDismiss = useCallback(() => {
    isOpen.current = false;
    onClose();
  }, [onClose]);

  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      animationConfigs={animationConfigs}
      onDismiss={handleDismiss}
      backdropComponent={backdrop}
      backgroundStyle={styles.bg}
      handleIndicatorStyle={styles.grabber}
    >
      <BottomSheetView style={{ paddingTop: 6, paddingBottom: Math.max(insets.bottom, 12) }}>
        {items.map((a, i) => (
          <Touchable
            key={a.id}
            haptic="light"
            onPress={() => {
              onPick(a.id);
              onClose();
            }}
            pressedStyle={{ backgroundColor: c.surfaceMuted }}
            style={[styles.actionRow, i > 0 && styles.actionDivider]}
          >
            <Text style={{ fontSize: font.body, fontWeight: '500', color: a.danger ? c.danger : c.fg }}>{a.label}</Text>
            <Icon name={a.icon} size={19} color={a.danger ? c.danger : c.fgMuted} />
          </Touchable>
        ))}
      </BottomSheetView>
    </BottomSheetModal>
  );
}

const useStyles = makeStyles((c) => ({
  bg: { backgroundColor: c.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22 },
  grabber: { backgroundColor: c.hairline, width: 38, height: 5 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hairline,
  },
  title: { fontSize: font.heading, fontWeight: '700', color: c.fg },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: c.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  actionDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.hairline },
}));
