/**
 * HScroll — the horizontal scroller for wide markdown blocks (tables, code, charts) that keeps
 * the conversation's full-width back gesture working when the swipe starts on the block:
 *
 *  - content that fits doesn't scroll at all (`scrollEnabled` off), so the back gesture gets
 *    the swipe;
 *  - at the leading edge it doesn't bounce: a rightward swipe there has nothing to scroll and
 *    goes back, a leftward one scrolls the block;
 *  - once scrolled away from the edge it's a plain scroller (bounces, owns the swipe): a
 *    rightward swipe first scrolls back to the start, like nested pagers in system apps.
 *
 * gesture-handler's ScrollView, so a sideways swipe is claimed even inside the vertical
 * conversation scroll.
 */
import React, { useCallback, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';

export function HScroll({
  children,
  contentContainerStyle,
  yieldAtStart = true,
}: {
  children: React.ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Off where nothing is behind (the full-screen table): bounce at both edges. */
  yieldAtStart?: boolean;
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
      bounces={!yieldAtStart || !atStart}
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
