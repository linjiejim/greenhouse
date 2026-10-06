/**
 * A handle on the conversation drawer's pan gesture (react-native-drawer-layout,
 * configured in app/(drawer)/_layout.tsx via `configureGestureHandler(g =>
 * g.withRef(drawerPanRef))`), so content that scrolls sideways inside the
 * conversation can cooperate with the swipe-right-from-anywhere drawer instead
 * of swallowing it — see src/chat/markdown/blocks/hscroll.tsx.
 */

import type { MutableRefObject } from 'react';
import type { GestureType } from 'react-native-gesture-handler';

export const drawerPanRef: MutableRefObject<GestureType | undefined> = { current: undefined };
