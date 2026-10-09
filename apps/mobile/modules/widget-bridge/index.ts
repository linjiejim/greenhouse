/**
 * JS face of the WidgetBridge native module (iOS only — Android/web are no-ops).
 * Publishes the home-screen widget's JSON snapshot (null clears it — logout)
 * and manages the avatar PNGs it points at in the App Group. Schema truth
 * lives in src/widget/model.ts.
 */

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

type WidgetBridgeNative = {
  setSnapshot: (json: string | null) => void;
  listArt: () => string[];
  writeArt: (key: string, base64: string) => boolean;
  pruneArt: (keep: string[]) => void;
} | null;

const native: WidgetBridgeNative =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NonNullable<WidgetBridgeNative>>('WidgetBridge') : null;

/** The bridge is in this binary (an OTA update can't add native code — older builds lack art). */
export const widgetArtSupported: boolean = typeof native?.writeArt === 'function';

export function setWidgetSnapshot(json: string | null): void {
  native?.setSnapshot(json);
}

/** Keys of the avatar PNGs already in the App Group. */
export function listWidgetArt(): string[] {
  return widgetArtSupported ? (native?.listArt() ?? []) : [];
}

/** Store one rendered face; false when it could not be written. */
export function writeWidgetArt(key: string, base64: string): boolean {
  return widgetArtSupported ? (native?.writeArt(key, base64) ?? false) : false;
}

/** Remove every avatar PNG not in `keep`. */
export function pruneWidgetArt(keep: string[]): void {
  if (widgetArtSupported) native?.pruneArt(keep);
}
