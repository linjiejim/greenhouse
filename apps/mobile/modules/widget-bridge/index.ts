/**
 * JS face of the WidgetBridge native module (iOS only — Android/web are no-ops).
 * Publishes the home-screen widget's JSON snapshot (null clears it — logout)
 * and manages the avatar PNGs it points at in the App Group. Schema truth
 * lives in src/widget/model.ts.
 *
 * Also runs a Bot's background tasks as Live Activities (iOS 17+): the shapes are
 * src/live-activity/model.ts (`BotTaskAttributes.swift` decodes exactly that JSON),
 * the decisions src/live-activity/controller.ts.
 */

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

type WidgetBridgeNative = {
  setSnapshot: (json: string | null) => void;
  listArt: () => string[];
  writeArt: (key: string, base64: string) => boolean;
  pruneArt: (keep: string[]) => void;
  // Live Activities — absent from binaries built before them (an OTA can't add native code)
  liveActivitiesState?: () => { supported: boolean; enabled: boolean };
  listTaskActivities?: () => string;
  startTaskActivity?: (json: string) => string | null;
  updateTaskActivity?: (id: string, json: string) => Promise<boolean>;
  endTaskActivity?: (id: string, json: string | null, dismissAt: number) => Promise<boolean>;
  endAllTaskActivities?: () => Promise<void>;
  readTaskActivityLog?: () => string;
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

// ─── Live Activities ─────────────────────────────────────

/** The OS can show task Live Activities (iOS 17+ with this binary), and the member allows them for the app. */
export function liveActivitiesState(): { supported: boolean; enabled: boolean } {
  return native?.liveActivitiesState?.() ?? { supported: false, enabled: false };
}

/** The task activities still around (ended ones too, until the system takes them off), as JSON. */
export function listTaskActivitiesJson(): string {
  return native?.listTaskActivities?.() ?? '[]';
}

/** Start one from `{attributes, state, staleAt, relevance}` (JSON) → its id, or null. */
export function startTaskActivity(json: string): string | null {
  return native?.startTaskActivity?.(json) ?? null;
}

export function updateTaskActivity(id: string, json: string): Promise<boolean> {
  return native?.updateTaskActivity?.(id, json) ?? Promise.resolve(false);
}

/** `json` `{state}` or null (keep the last state); `dismissAt` Unix seconds, 0 = at once. */
export function endTaskActivity(id: string, json: string | null, dismissAt: number): Promise<boolean> {
  return native?.endTaskActivity?.(id, json, dismissAt) ?? Promise.resolve(false);
}

export function endAllTaskActivities(): Promise<void> {
  return native?.endAllTaskActivities?.() ?? Promise.resolve();
}

/** What the background end did with each task push (JSON, oldest first) — dogfood diagnostics. */
export function readTaskActivityLog(): string {
  return native?.readTaskActivityLog?.() ?? '[]';
}
