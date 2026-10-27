/**
 * JS face of the WidgetBridge native module (iOS only; elsewhere a no-op): publishes the widgets'
 * JSON snapshot into the App Group (null clears it, on sign-out). Shape: src/widget/model.ts.
 */

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

type WidgetBridgeNative = { setSnapshot: (json: string | null) => void } | null;

const native: WidgetBridgeNative =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NonNullable<WidgetBridgeNative>>('WidgetBridge') : null;

export function setWidgetSnapshot(json: string | null): void {
  native?.setSnapshot(json);
}
