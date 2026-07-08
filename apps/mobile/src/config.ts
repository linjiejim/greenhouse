/**
 * Build-time defaults.
 *
 * The server origin is no longer hard-wired: users manage "stations" (saved
 * connections to self-hosted deployments) at runtime and every API call
 * resolves the active one via getApiBase() (src/store/stations.ts).
 *
 * EXPO_PUBLIC_API_BASE_URL now only *seeds* the registry on first launch —
 * set it for builds pinned to one deployment; leave it unset for the generic
 * store build (the user adds their own server). Dev default: localhost:3000
 * (Android emulator: 10.0.2.2:3000; devices: the Mac's LAN IP).
 *
 * Requests omit workspace_id — the backend uses the user's default workspace.
 */
export const HAS_PINNED_BASE = Boolean(process.env.EXPO_PUBLIC_API_BASE_URL);
export const DEFAULT_API_BASE = (process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
