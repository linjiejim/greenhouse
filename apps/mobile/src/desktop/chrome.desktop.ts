import type { ViewStyle } from 'react-native';
import { invoke, reportNativeError } from './native';
export const shellChrome: ViewStyle = { backgroundColor: 'transparent' };
export const railChrome: ViewStyle = { paddingTop: 52, backgroundColor: 'transparent' };
export const secondaryChrome: ViewStyle = { backgroundColor: 'transparent' };
export function syncNativePlaces(places: { id: string; label: string; href: string }[]): void {
  if (window.__GREENHOUSE_WINDOW__ !== 'main') return;
  void invoke('sync_places', { places }).catch(reportNativeError);
}
export function openSettings(_fallback: () => void): void {
  void invoke('open_settings').catch(reportNativeError);
}
export function closeSettings(fallback: () => void): void {
  if (window.__GREENHOUSE_WINDOW__ === 'settings') void invoke('close_window').catch(reportNativeError);
  else fallback();
}
export function openStationSettings(_fallback: () => void): void {
  void invoke('open_main', { route: '/me/stations' }).catch(reportNativeError);
}
