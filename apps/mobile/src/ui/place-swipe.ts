/**
 * Each place's stack tells the drawer whether its edge swipe may open the sidebar: as a page of
 * the stack gains focus, the drawer screen's `swipeEnabled` follows the stack's depth
 * (src/shell/layout-rule.ts). The drawer's own options cannot see this: under expo-router its
 * routes carry no nested stack state, and its layout does not re-render on a push.
 */

import { useCallback } from 'react';
import { drawerSwipes } from '../shell/layout-rule';
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
