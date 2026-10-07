/**
 * Thin wrappers over expo-haptics for *custom* controls (native controls
 * bring their own): light impact on send, medium on long-press, selection
 * tick on picks / toggles. Best-effort, never throw (haptics are unavailable
 * on some devices and the simulator).
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
