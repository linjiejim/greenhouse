/**
 * Thin wrappers over expo-haptics. Used for the "physical" feel the PRD calls
 * for: light impact on send / tab / long-press, selection tick on toggles,
 * success notification on task completion. All calls are best-effort and never
 * throw (haptics are unavailable on some devices / the simulator).
 */

import * as Haptics from 'expo-haptics';

export function tapLight(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function tapMedium(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

export function selectionTick(): void {
  Haptics.selectionAsync().catch(() => {});
}

export function notifySuccess(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}
