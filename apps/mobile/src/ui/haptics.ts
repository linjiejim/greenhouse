/**
 * Thin wrappers over expo-haptics for *custom* controls (native controls
 * bring their own): light impact on send, medium on long-press, selection
 * tick on picks / toggles, and the notification pair for outcomes the member
 * is waiting on (a card decision went through / something needs them now).
 * Best-effort, never throw (haptics are unavailable on some devices and the
 * simulator).
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

/** A decision the member made went through (a card approved, a Bot created). */
export function notifySuccess(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** Something needs the member right now (a card arriving in the thread on screen). */
export function notifyWarning(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
}
