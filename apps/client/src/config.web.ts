import { browserStationId } from './stations/browser-origin';
import type { ClientStationsConfig } from './shared/greenhouse-config';
/** Browser builds have exactly their hosting station. A dev build may explicitly override it. */
export const DEFAULT_API_BASE =
  process.env.EXPO_PUBLIC_API_BASE_URL || (typeof location === 'undefined' ? 'http://localhost' : location.origin);
export const STATIONS: ClientStationsConfig = {
  mode: 'single',
  defaults: [{ id: browserStationId(DEFAULT_API_BASE), name: new URL(DEFAULT_API_BASE).host, url: DEFAULT_API_BASE }],
};
export const IS_SINGLE_STATION = true;
export const HAS_PINNED_BASE = true;
