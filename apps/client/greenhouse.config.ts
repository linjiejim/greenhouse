/**
 * Client-stations configuration of this mobile build — the counterpart of the
 * `clients.stations` section in the repository's `greenhouse.config.ts`. The
 * app lives outside the pnpm workspace and Expo bakes configuration in from
 * `EXPO_PUBLIC_*` env at build / export time, so the section is assembled
 * from env here (shapes vendored in src/shared/greenhouse-config.ts):
 *
 *   EXPO_PUBLIC_STATIONS_MODE  'multi' (default) | 'single'
 *   EXPO_PUBLIC_API_BASE_URL   origin of the default station → one `defaults`
 *                              entry when set, none otherwise
 *   EXPO_PUBLIC_STATION_NAME   its display name (default: the host)
 *
 * `multi` seeds the default station on first launch and lets users add /
 * switch servers; `single` locks the build to it — no add / remove / switch
 * (src/store/stations.ts). A `single` build without a URL, or an unknown mode,
 * throws here at import time so a misconfigured build fails closed instead of
 * shipping with no server.
 */

import type { ClientStationsConfig, StationConfig } from './src/shared/greenhouse-config';

// Static member access only — Expo inlines `process.env.EXPO_PUBLIC_*` by name.
const MODE = process.env.EXPO_PUBLIC_STATIONS_MODE;
const BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;
const STATION_NAME = process.env.EXPO_PUBLIC_STATION_NAME;

function defaultStation(): StationConfig | null {
  const url = BASE_URL?.trim().replace(/\/+$/, '');
  if (!url) return null;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Not a full URL (e.g. a bare LAN host) — the station store normalizes it on seed.
  }
  const id = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  return { id, name: STATION_NAME?.trim() || host, url };
}

function stationsFromEnv(): ClientStationsConfig {
  const mode = MODE?.trim() || 'multi';
  if (mode !== 'multi' && mode !== 'single') {
    throw new Error(`EXPO_PUBLIC_STATIONS_MODE must be 'multi' or 'single', got '${mode}'`);
  }
  const station = defaultStation();
  if (mode === 'single' && !station) {
    throw new Error("EXPO_PUBLIC_STATIONS_MODE='single' needs EXPO_PUBLIC_API_BASE_URL — the station this build is locked to");
  }
  return { mode, defaults: station ? [station] : [] };
}

export const stations: ClientStationsConfig = stationsFromEnv();
