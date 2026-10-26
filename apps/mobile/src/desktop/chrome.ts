import type { ViewStyle } from 'react-native';
export const shellChrome: ViewStyle = {};
export const railChrome: ViewStyle = { paddingTop: 16 };
export const secondaryChrome: ViewStyle = {};
export function syncNativePlaces(_places: { id: string; label: string; href: string }[]): void {}
export function openSettings(fallback: () => void): void {
  fallback();
}
export function closeSettings(fallback: () => void): void {
  fallback();
}
export function openStationSettings(fallback: () => void): void {
  fallback();
}
