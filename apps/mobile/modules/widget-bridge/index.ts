/**
 * JS face of the WidgetBridge native module (iOS only — Android/web are no-ops).
 * Pass a JSON snapshot string to publish it to the home-screen widget, or null
 * to clear it (logout). Schema truth lives in src/lib/widget-snapshot.ts.
 */

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

type WidgetBridgeNative = { setSnapshot: (json: string | null) => void } | null;

const native: WidgetBridgeNative =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NonNullable<WidgetBridgeNative>>('WidgetBridge') : null;

export function setWidgetSnapshot(json: string | null): void {
  native?.setSnapshot(json);
}
