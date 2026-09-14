/**
 * Build-time client configuration — the `clients.stations` section of the
 * repository's `greenhouse.config.ts`, bundled by Vite so a deployment ships
 * its own extension build.
 *
 * `multi` (OSS default): users add and switch stations freely; `defaults` are
 * seeded into the registry on first launch. `single`: the build is locked to
 * `defaults[0]` — the registry only ever holds that station and the add /
 * remove / switch paths are guarded in `lib/storage.ts`, so no UI can escape
 * the lock. A `single` build without its station fails here, at module load,
 * rather than shipping with no server (same rule as the server-side schema).
 */

import { mergeGreenhouseConfig, type ClientStationsConfig, type StationConfig } from '@greenhouse/types/config';
import config from '../../../greenhouse.config';

export const STATIONS: ClientStationsConfig = mergeGreenhouseConfig(config).clients.stations;

if (STATIONS.mode === 'single' && STATIONS.defaults.length !== 1) {
  throw new Error(
    "greenhouse.config.ts: clients.stations.mode 'single' needs exactly one entry in clients.stations.defaults",
  );
}

/** True when this build is locked to one station (no add / remove / switch). */
export function isSingleStation(): boolean {
  return STATIONS.mode === 'single';
}

/** Stations seeded on first launch (`multi`), or the one locked station (`single`). */
export function defaultStations(): StationConfig[] {
  return STATIONS.defaults;
}
