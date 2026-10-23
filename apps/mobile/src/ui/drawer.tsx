/**
 * Drawer behaviour for home (react-native-drawer-layout via expo-router's `Drawer` — see
 * app/(drawer)/_layout.tsx). The panel body is src/shell/drawer-content.tsx.
 */

import { Dimensions } from 'react-native';
import type { DrawerNavigationOptions } from 'expo-router/drawer';
import type { HexPalette, ThemeColors } from '../theme';

const { width: SCREEN_W } = Dimensions.get('window');
/** Panel width: most of the screen, home peeks out. */
export const DRAWER_W = Math.min(340, Math.round(SCREEN_W * 0.84));

/**
 * The drawer's behaviour — tuned to feel like a native iOS sidebar you can
 * grab from anywhere:
 *  - `slide`: home slides away with the panel (no floating card),
 *  - swipe from *anywhere* on the surface (not just the edge) to open,
 *  - the pan only activates on a deliberate horizontal move and fails fast on
 *    vertical ones, so list scrolling and swipe actions keep priority,
 *  - a light dim over the pushed-aside home; tap it to close.
 * Runs on the UI thread (react-native-drawer-layout on Reanimated + RNGH).
 */
export function drawerScreenOptions(c: ThemeColors, hex: HexPalette): DrawerNavigationOptions {
  return {
    headerShown: false,
    drawerType: 'slide',
    drawerPosition: 'left',
    swipeEnabled: true,
    swipeEdgeWidth: SCREEN_W,
    swipeMinDistance: 24,
    configureGestureHandler: (g) => g.activeOffsetX([-14, 14]).failOffsetY([-12, 12]),
    overlayColor: hex.scrim,
    keyboardDismissMode: 'on-drag',
    drawerStyle: {
      width: DRAWER_W,
      backgroundColor: c.background,
    },
    sceneStyle: { backgroundColor: c.background },
  };
}
