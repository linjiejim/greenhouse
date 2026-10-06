/**
 * HScroll — the horizontal scroller for wide markdown blocks (tables, code,
 * charts) that keeps the conversation's swipe-right-from-anywhere drawer
 * working when the swipe starts on the block:
 *
 *  - content that fits doesn't scroll at all (`scrollEnabled` off), so the
 *    drawer's pan simply gets the swipe;
 *  - at the leading edge the scroller recognizes *together* with the drawer's
 *    pan (`simultaneousHandlers={drawerPanRef}`, src/chat/drawer-gesture.ts)
 *    and doesn't bounce: a rightward swipe there has nothing to scroll and
 *    opens the drawer, a leftward one scrolls the block (the closed drawer
 *    can't move further left);
 *  - once scrolled away from the edge it's a plain scroller (bounces, owns the
 *    swipe): a rightward swipe first scrolls back to the start — the next one
 *    opens the drawer, like nested pagers in system apps.
 *
 * gesture-handler's ScrollView, so a sideways swipe is claimed even inside the
 * vertical conversation scroll (and so it can name the drawer's gesture).
 */
import React, { useCallback, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { drawerPanRef } from '../../drawer-gesture';

export function HScroll({
  children,
  contentContainerStyle,
  yieldToDrawer = true,
}: {
  children: React.ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Off where there's no drawer behind (the full-screen table): bounce at both edges. */
  yieldToDrawer?: boolean;
}) {
  const [viewportW, setViewportW] = useState(0);
  const [contentW, setContentW] = useState(0);
  const [atStart, setAtStart] = useState(true);
  const atStartRef = useRef(true);
  const scrollable = viewportW > 0 && contentW > viewportW + 1;

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const start = e.nativeEvent.contentOffset.x <= 0.5;
    if (start !== atStartRef.current) {
      atStartRef.current = start;
      setAtStart(start);
    }
  }, []);

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      scrollEnabled={scrollable}
      bounces={!yieldToDrawer || !atStart}
      simultaneousHandlers={yieldToDrawer && atStart ? drawerPanRef : undefined}
      alwaysBounceHorizontal={false}
      scrollEventThrottle={16}
      onScroll={onScroll}
      onLayout={(e) => setViewportW(e.nativeEvent.layout.width)}
      onContentSizeChange={(w) => setContentW(w)}
      contentContainerStyle={contentContainerStyle}
    >
      {children}
    </ScrollView>
  );
}
