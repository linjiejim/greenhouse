#!/usr/bin/env node
/**
 * Build-time deployment overlay for `tauri.conf.json`.
 *
 * The committed config is deployment-neutral: the open-source identity, no update
 * feed, a CSP that only knows the local dev servers. A deployment that builds its
 * own shell (a company's private fork, CI for the public release) sets a handful
 * of `GREENHOUSE_DESKTOP_*` variables and this module turns them into the JSON
 * overlay the Tauri CLI merges over the file (`tauri build --config <json>`), so
 * nothing under `apps/desktop` has to be edited or forked:
 *
 *   GREENHOUSE_DESKTOP_IDENTIFIER       bundle identifier (app-data dir, macOS permission
 *                                       identity — an installed base keeps its own)
 *   GREENHOUSE_DESKTOP_PRODUCT_NAME     window / bundle name (default: Greenhouse)
 *   GREENHOUSE_DESKTOP_API_BASE         the server every install talks to (also read by
 *                                       build.rs → settings.rs; here it widens the CSP)
 *   GREENHOUSE_DESKTOP_UPDATE_BASE      update source, when it is not `<API base>/updates/desktop`
 *   GREENHOUSE_DESKTOP_UPDATER_PUBKEY   minisign public key of TAURI_SIGNING_PRIVATE_KEY —
 *                                       without it the shell cannot verify shell updates
 *   GREENHOUSE_DESKTOP_CSP_EXTRA_ORIGINS  comma-separated extra origins for connect/img/media
 *                                       (an object-storage CDN, an avatar service, …)
 *
 * Exported for tests; run as a script it prints the overlay (or nothing when no
 * variable is set, so a plain `tauri build` stays a plain build).
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Origins the committed CSP already allows for local development. */
const LOCAL_ORIGINS = ['http://localhost:3100', 'http://localhost:3000'];

/** Directives that must name the server and any extra origin. */
const NETWORK_DIRECTIVES = ['connect-src', 'img-src', 'media-src'];

function originOf(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** `https://host` → also `wss://host`, so the API's WebSocket passes connect-src. */
function socketOrigin(origin) {
  return origin.replace(/^http/, 'ws');
}

/**
 * Widen the network directives of a CSP string with the given origins.
 * Everything else in the policy is left byte-for-byte as committed.
 */
export function widenCsp(csp, origins) {
  if (origins.length === 0) return csp;
  return csp
    .split(';')
    .map((directive) => {
      const trimmed = directive.trim();
      const name = trimmed.split(/\s+/)[0];
      if (!NETWORK_DIRECTIVES.includes(name)) return directive;
      const extra = origins.filter((origin) => !trimmed.includes(` ${origin}`));
      const withSockets = name === 'connect-src' ? extra.flatMap((origin) => [origin, socketOrigin(origin)]) : extra;
      return withSockets.length === 0 ? directive : `${directive} ${withSockets.join(' ')}`;
    })
    .join(';');
}

/**
 * The overlay for one environment. `baseCsp` is the committed policy (passed in so
 * the function stays pure and testable); the result is `null` when no deployment
 * variable is set.
 */
export function buildTauriConfigOverlay(env, baseCsp) {
  const overlay = {};

  const identifier = env.GREENHOUSE_DESKTOP_IDENTIFIER?.trim();
  if (identifier) overlay.identifier = identifier;

  const productName = env.GREENHOUSE_DESKTOP_PRODUCT_NAME?.trim();
  if (productName) overlay.productName = productName;

  const pubkey = env.GREENHOUSE_DESKTOP_UPDATER_PUBKEY?.trim();
  if (pubkey) overlay.plugins = { updater: { pubkey } };

  const origins = [];
  const apiBase = env.GREENHOUSE_DESKTOP_API_BASE?.trim();
  if (apiBase) {
    const origin = originOf(apiBase);
    if (!origin || origin !== apiBase.replace(/\/+$/, '')) {
      throw new Error(`GREENHOUSE_DESKTOP_API_BASE must be a bare http(s) origin, got ${JSON.stringify(apiBase)}`);
    }
    origins.push(origin);
  }
  const updateBase = env.GREENHOUSE_DESKTOP_UPDATE_BASE?.trim();
  if (updateBase) {
    const origin = originOf(updateBase);
    if (!origin)
      throw new Error(`GREENHOUSE_DESKTOP_UPDATE_BASE must be an http(s) URL, got ${JSON.stringify(updateBase)}`);
    origins.push(origin);
  }
  for (const raw of (env.GREENHOUSE_DESKTOP_CSP_EXTRA_ORIGINS ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    // Wildcard hosts (`https://*.example.com`) are valid CSP sources but not URLs.
    if (!/^https?:\/\/[^\s/]+$/.test(entry)) {
      throw new Error(`GREENHOUSE_DESKTOP_CSP_EXTRA_ORIGINS entries must be origins, got ${JSON.stringify(entry)}`);
    }
    origins.push(entry);
  }
  const unique = [...new Set(origins)].filter((origin) => !LOCAL_ORIGINS.includes(origin));
  if (unique.length > 0) {
    overlay.app = { security: { csp: widenCsp(baseCsp, unique) } };
  }

  return Object.keys(overlay).length === 0 ? null : overlay;
}

/** Read the committed policy so the CLI and the wrapper widen the same baseline. */
export async function committedCsp() {
  const { readFileSync } = await import('node:fs');
  const confPath = resolve(fileURLToPath(import.meta.url), '../../src-tauri/tauri.conf.json');
  return JSON.parse(readFileSync(confPath, 'utf8')).app.security.csp;
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const overlay = buildTauriConfigOverlay(process.env, await committedCsp());
  if (overlay) process.stdout.write(`${JSON.stringify(overlay)}\n`);
}
