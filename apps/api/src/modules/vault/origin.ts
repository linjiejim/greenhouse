/**
 * Which sites a vault login may ever be filled into. Exact origins by default
 * (`https://host[:port]`); subdomains only when the member wrote `*.host` (https). No matching on
 * the registrable domain: `sites.google.com` or a tenant subdomain never inherits its parent's
 * password. Plain http only for localhost in development and tests. Greenhouse's own origins are
 * refused outright: an Agent that could sign in to Greenhouse could approve its own cards.
 *
 * Comparisons run on WHATWG origins (`new URL().origin`): lower case, punycode, default ports
 * dropped. The page's origin always comes from the browser, never from the model.
 */

import { ApiError } from '../../http/errors.js';
import { originOf } from '../computers/browser.js';

const DEV_HTTP_HOSTS = new Set(['localhost', '127.0.0.1']);
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface OriginPolicy {
  /** NODE_ENV: development and test allow http://localhost. */
  nodeEnv: string;
  /** Greenhouse's own origins. */
  forbidden: readonly string[];
}

const invalid = (message: string): never => {
  throw new ApiError(400, 'origin_invalid', message);
};

/** Whether `*.host[:port]` covers an origin: a subdomain over https on the same port. */
function wildcardCovers(pattern: string, origin: string): boolean {
  let target: URL;
  let suffix: URL;
  try {
    target = new URL(origin);
    suffix = new URL(`https://${pattern.slice(2)}`);
  } catch {
    return false;
  }
  return target.protocol === 'https:' && target.port === suffix.port && target.hostname.endsWith(`.${suffix.hostname}`);
}

/** One site as the member wrote it, stored as an exact origin or an explicit `*.host`. */
export function normalizeSite(input: string, policy: OriginPolicy): string {
  let value = input.trim();
  if (!value) invalid('Enter a site, like https://github.com.');
  if (value.length > 300) invalid('That site address is too long.');
  value = value.replace(/\/+$/, '');
  const wildcard = /^(?:https:\/\/)?\*\.(.+)$/i.exec(value);
  if (wildcard) {
    let parsed!: URL;
    try {
      parsed = new URL(`https://${wildcard[1]}`);
    } catch {
      invalid(`"${input.trim().slice(0, 100)}" is not a valid site.`);
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      invalid('Enter just the site, without a path (like *.example.com).');
    }
    if (IPV4.test(parsed.hostname) || parsed.hostname.startsWith('['))
      invalid('Wildcards cannot be used with IP addresses.');
    if (!parsed.hostname.includes('.')) invalid('A wildcard needs a full domain, like *.example.com.');
    const pattern = `*.${parsed.host}`;
    if (policy.forbidden.some((origin) => wildcardCovers(pattern, origin))) {
      throw new ApiError(400, 'origin_forbidden', 'Greenhouse itself cannot be a vault site.');
    }
    return pattern;
  }
  if (/^http:\/\/\*\./i.test(value)) invalid('Wildcard sites must use https.');
  let parsed!: URL;
  try {
    parsed = new URL(SCHEME.test(value) ? value : `https://${value}`);
  } catch {
    invalid(`"${input.trim().slice(0, 100)}" is not a valid site.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') invalid('Only https sites can be saved.');
  if (parsed.username || parsed.password) invalid('Enter the site without a user name.');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    invalid('Enter just the site, without a path (like https://github.com).');
  }
  const dev = policy.nodeEnv === 'development' || policy.nodeEnv === 'test';
  if (parsed.protocol === 'http:' && !(dev && DEV_HTTP_HOSTS.has(parsed.hostname)))
    invalid('Only https sites can be saved.');
  if (policy.forbidden.includes(parsed.origin)) {
    throw new ApiError(400, 'origin_forbidden', 'Greenhouse itself cannot be a vault site.');
  }
  return parsed.origin;
}

/** The sites of a login: normalised and without repeats. */
export function normalizeSites(inputs: readonly string[], policy: OriginPolicy): string[] {
  if (!inputs.length) invalid('Add at least one site.');
  return [...new Set(inputs.map((input) => normalizeSite(input, policy)))];
}

/** Whether a page origin, as the browser reported it, is one of these sites. */
export function originMatches(patterns: readonly string[], origin: string | null): boolean {
  if (!origin || originOf(origin) !== origin) return false;
  return patterns.some((pattern) => (pattern.startsWith('*.') ? wildcardCovers(pattern, origin) : pattern === origin));
}

/** The host of an origin, for cards and lines a person reads. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
