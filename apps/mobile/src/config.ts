/**
 * Build-time defaults.
 *
 * The server origin is not hard-wired: users manage "stations" (saved
 * connections to self-hosted deployments) at runtime and every API call
 * resolves the active one via getApiBase() (src/store/stations.ts).
 *
 * What a build ships is `STATIONS` — the client-stations config assembled from
 * `EXPO_PUBLIC_*` env in ../greenhouse.config.ts: `defaults` seed the registry
 * on first launch (EXPO_PUBLIC_API_BASE_URL → one entry) and `mode: 'single'`
 * locks the build to that station. Leave the URL unset for the generic store
 * build (the user adds their own server). Dev fallback: localhost:3000
 * (Android emulator: 10.0.2.2:3000; devices: the Mac's LAN IP).
 *
 * Requests omit workspace_id — the backend uses the user's default workspace.
 */
import { stations } from '../greenhouse.config';
import type { ClientStationsConfig } from './shared/greenhouse-config';

export const STATIONS: ClientStationsConfig = stations;
/** True when this build is locked to `STATIONS.defaults[0]` — no add / remove / switch. */
export const IS_SINGLE_STATION = STATIONS.mode === 'single';
/** A default station is configured (EXPO_PUBLIC_API_BASE_URL set). */
export const HAS_PINNED_BASE = STATIONS.defaults.length > 0;
/** First default station's origin, or the dev fallback when none is configured. */
export const DEFAULT_API_BASE = STATIONS.defaults[0]?.url ?? 'http://localhost:3000';
