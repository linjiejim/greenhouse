/**
 * Vendored copy of the client-stations config shapes — the canonical source is
 * packages/types/src/config.ts (`StationConfig`, `ClientStationsConfig`).
 *
 * The mobile app is kept OUT of the pnpm workspace (see AGENTS.md) so its
 * React-Native / React-19 dependency graph can't pollute the web/api packages'
 * shared store; the price is that it cannot import `@greenhouse/types/config`.
 * When the canonical shapes change, update this file to match.
 */

/** One Greenhouse server as seen by a client (browser extension, mobile app). */
export interface StationConfig {
  /** Stable id, lowercase letters / digits / dashes. */
  id: string;
  /** Display name shown in the station switcher. */
  name: string;
  /** Origin of the instance, e.g. `https://greenhouse.example.com` (no path). */
  url: string;
}

/**
 * How a client build treats server stations.
 *
 * - `multi` (OSS default): users add and switch stations freely; `defaults` are
 *   offered on first launch.
 * - `single`: the build is locked to exactly one station — no add / remove / switch
 *   UI, `defaults[0]` is the station. This is how a company build pins its own
 *   deployment.
 */
export interface ClientStationsConfig {
  mode: 'multi' | 'single';
  defaults: StationConfig[];
}
