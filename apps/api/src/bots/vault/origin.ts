/**
 * Vault origin binding — which sites an entry may ever be filled into.
 *
 * Exact origins by default (`https://host[:port]`); subdomains match only when
 * the member typed an explicit `*.host` (stored without a scheme, https
 * implied). No eTLD+1 matching: `sites.google.com` or a SaaS tenant subdomain
 * must never inherit the parent site's password. Plain http is refused except
 * `http://localhost` / `http://127.0.0.1` on development and test runtimes
 * (local fixtures). greenhouse's own origins are refused outright — a Bot that
 * could fill the member's greenhouse login into its own browser could approve
 * its own requests.
 *
 * Every comparison runs on WHATWG-normalised origins (`new URL().origin`):
 * lower-case, punycode hosts, default ports dropped, IPv6 bracketed.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §8, design-review R10.
 */

import { VaultError } from './crypto.js';

const DEV_HTTP_HOSTS = new Set(['localhost', '127.0.0.1']);
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface OriginPolicy {
  /** NODE_ENV — `development`/`test` allow http://localhost fixtures. */
  nodeEnv?: string;
  /** greenhouse's own origins (defaults to the deployment's base-URL env vars). */
  forbidden?: readonly string[];
}

function isDevRuntime(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/** The page origin of a URL, or null for anything that is not http(s) (about:, data:, file:, chrome:…). */
export function originOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** `https://host[:port]` → host (punycode) without the port. */
export function hostOfOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/**
 * greenhouse's own origins, from the base-URL settings an operator already
 * configures. Unset variables simply contribute nothing.
 */
export function greenhouseOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = [
    env.PUBLIC_BASE_URL,
    env.APP_BASE_URL,
    env.API_BASE_URL,
    env.WEB_BASE_URL,
    ...(env.CORS_ALLOWED_ORIGINS ?? '').split(','),
  ];
  const out = new Set<string>();
  for (const value of raw) {
    const origin = originOfUrl(value?.trim());
    if (origin) out.add(origin);
  }
  return [...out];
}

function invalid(message: string): never {
  throw new VaultError('origin_invalid', message);
}

/**
 * Normalise one site the member entered into a stored pattern: an exact
 * origin (`https://github.com`) or an explicit wildcard (`*.github.com`).
 * A bare host gets https. Paths, queries, credentials and other schemes are
 * refused rather than silently dropped, so what is stored is exactly what
 * the member sees.
 */
export function normalizeOriginPattern(input: string, policy: OriginPolicy = {}): string {
  const nodeEnv = policy.nodeEnv ?? process.env.NODE_ENV;
  const forbidden = policy.forbidden ?? greenhouseOrigins();
  let value = input.trim();
  if (!value) invalid('Enter a site, e.g. https://github.com');
  if (value.length > 300) invalid('That site address is too long');
  value = value.replace(/\/+$/, '');

  const wildcard = /^(?:https:\/\/)?\*\.(.+)$/i.exec(value);
  if (wildcard) {
    let parsed: URL;
    try {
      parsed = new URL(`https://${wildcard[1]}`);
    } catch {
      return invalid(`"${input.trim()}" is not a valid site`);
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      invalid('Enter just the site, without a path (e.g. *.example.com)');
    }
    const host = parsed.hostname;
    if (IPV4.test(host) || host.startsWith('[')) invalid('Wildcards cannot be used with IP addresses');
    if (!host.includes('.')) invalid('A wildcard needs a full domain, e.g. *.example.com');
    const pattern = `*.${parsed.host}`;
    if (forbidden.some((origin) => wildcardCovers(pattern, origin))) {
      throw new VaultError('origin_forbidden', 'greenhouse itself cannot be a vault site');
    }
    return pattern;
  }
  if (/^http:\/\/\*\./i.test(value)) invalid('Wildcard sites must use https');

  let parsed: URL;
  try {
    parsed = new URL(SCHEME.test(value) ? value : `https://${value}`);
  } catch {
    return invalid(`"${input.trim()}" is not a valid site`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') invalid('Only https sites can be saved');
  if (parsed.username || parsed.password) invalid('Enter the site without a user name');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    invalid('Enter just the site, without a path (e.g. https://github.com)');
  }
  if (!parsed.hostname) invalid(`"${input.trim()}" is not a valid site`);
  if (parsed.protocol === 'http:' && !(isDevRuntime(nodeEnv) && DEV_HTTP_HOSTS.has(parsed.hostname))) {
    invalid('Only https sites can be saved');
  }
  const origin = parsed.origin;
  if (forbidden.includes(origin)) {
    throw new VaultError('origin_forbidden', 'greenhouse itself cannot be a vault site');
  }
  return origin;
}

/** Normalise and de-duplicate a list of sites (1–20). */
export function normalizeOriginPatterns(inputs: readonly string[], policy: OriginPolicy = {}): string[] {
  if (inputs.length === 0) invalid('Add at least one site');
  if (inputs.length > 20) invalid('At most 20 sites per entry');
  return [...new Set(inputs.map((input) => normalizeOriginPattern(input, policy)))];
}

/** Whether a stored `*.host[:port]` pattern covers an exact origin (subdomains only, https only). */
function wildcardCovers(pattern: string, origin: string): boolean {
  let target: URL;
  let suffix: URL;
  try {
    target = new URL(origin);
    suffix = new URL(`https://${pattern.slice(2)}`);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:') return false;
  if (target.port !== suffix.port) return false;
  return target.hostname.endsWith(`.${suffix.hostname}`);
}

/**
 * Whether a page origin (from the browser, never from the model) matches one
 * of an entry's stored patterns. `origin` must already be a normalised origin
 * (`originOfUrl`); anything else never matches.
 */
export function originMatches(patterns: readonly string[], origin: string | null): boolean {
  if (!origin || originOfUrl(origin) !== origin) return false;
  return patterns.some((pattern) => (pattern.startsWith('*.') ? wildcardCovers(pattern, origin) : pattern === origin));
}

/** Whether an origin is greenhouse itself (never browse-fill there). */
export function isGreenhouseOrigin(origin: string | null, forbidden: readonly string[] = greenhouseOrigins()): boolean {
  return !!origin && forbidden.includes(origin);
}
