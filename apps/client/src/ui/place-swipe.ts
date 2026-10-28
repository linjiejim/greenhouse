/**
 * Each place's stack tells the drawer whether its edge swipe may open the sidebar: as a page of
 * the stack gains focus, the drawer screen's `swipeEnabled` follows the stack's depth
 * (src/shell/layout-rule.ts). The drawer's own options cannot see this: under expo-router its
 * routes carry no nested stack state, and its layout does not re-render on a push.
 */

import { useCallback, useEffect } from 'react';
import { useWindowDimensions } from 'react-native';
import { useIsFocused, useNavigation } from 'expo-router';
import { useDrawerStatus } from 'expo-router/drawer';
import type { PanGesture } from 'react-native-gesture-handler';
import { drawerSwipes, drawerSwipeWidth } from '../shell/layout-rule';
import { usePersistentSidebar } from './sidebar';

/** The part of a stack page's navigation this needs. */
interface PageNavigation {
  getState: () => { index?: number } | undefined;
  getParent: () => { setOptions: (options: { swipeEnabled: boolean }) => void } | undefined;
}

/** `screenListeners` for a place's `<Stack>`. */
export function usePlaceSwipe() {
  const persistent = usePersistentSidebar();
  return useCallback(
    ({ navigation }: { navigation: PageNavigation }) => ({
      focus: () => {
        const depth = navigation.getState()?.index ?? 0;
        navigation.getParent()?.setOptions({ swipeEnabled: drawerSwipes(persistent, depth) });
      },
    }),
    [persistent],
  );
}

/** The whole-page swipe opens the drawer only rightward: a leftward one is a row's own swipe. */
const rightwardOnly = (gesture: PanGesture) => gesture.activeOffsetX([-100_000, 5]);

/**
 * A place's first page (home, 知识库, 云盘, 项目, 定时任务): a rightward swipe anywhere on it opens
 * the sidebar, not only from the edge. `busy` keeps the edge while a horizontal drag means
 * something else there (home's composer). Deeper pages keep the system back swipe (usePlaceSwipe).
 */
export function useWholePageDrawerSwipe(busy = false) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const open = useDrawerStatus() === 'open';
  const persistent = usePersistentSidebar();
  const { width: windowWidth } = useWindowDimensions();
  // only the stack's first page: a folder pushed in the same place reuses this screen
  const first = (navigation.getState()?.index ?? 0) === 0;
  const width = drawerSwipeWidth({ wholePage: focused && first && !persistent, composing: busy, open, windowWidth });
  useEffect(() => {
    if (!focused || !first) return;
    const wide = width > windowWidth / 2;
    navigation.getParent()?.setOptions({ swipeEdgeWidth: width, configureGestureHandler: wide ? rightwardOnly : undefined });
  }, [navigation, focused, first, width, windowWidth]);
}
