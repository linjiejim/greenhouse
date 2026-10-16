/**
 * A credential is only ever sent to the endpoint it was configured for. Every adapter gets
 * a fetch that refuses any other origin, whatever URL the SDK or a redirect produces.
 *
 * An entry whose host starts with `*.` allows every host under that domain, with the same scheme
 * and port: a provider that serves each sandbox on a name of its own (E2B: `<port>-<id>.<domain>`).
 */

export class EndpointViolation extends Error {
  constructor(
    readonly attempted: string,
    readonly allowed: string[],
  ) {
    super(`Blocked a request to ${attempted}: this provider instance may only call ${allowed.join(', ') || 'nothing'}`);
  }
}

const MAX_REDIRECTS = 5;

type Rule = { origin: string } | { protocol: string; port: string; suffix: string };

function rulesOf(allowed: readonly string[] | null): Rule[] {
  return (allowed ?? []).map((endpoint) => {
    const url = new URL(endpoint);
    return url.hostname.startsWith('*.')
      ? { protocol: url.protocol, port: url.port, suffix: url.hostname.slice(1) }
      : { origin: url.origin };
  });
}

function matches(rules: readonly Rule[], href: string): boolean {
  const url = new URL(href);
  return rules.some((rule) =>
    'origin' in rule
      ? rule.origin === url.origin
      : url.protocol === rule.protocol &&
        url.port === rule.port &&
        url.hostname.endsWith(rule.suffix) &&
        url.hostname.length > rule.suffix.length,
  );
}

const shown = (allowed: readonly string[] | null) =>
  rulesOf(allowed).map((rule) =>
    'origin' in rule ? rule.origin : `${rule.protocol}//*${rule.suffix}${rule.port ? `:${rule.port}` : ''}`,
  );

/** Whether a URL is one the instance may reach; for connections that do not go through fetch (WebSockets). */
export function isPinned(allowed: readonly string[] | null, href: string): boolean {
  return matches(rulesOf(allowed), href);
}

/** Throws unless the instance may reach this URL. */
export function assertPinned(allowed: readonly string[] | null, href: string): void {
  if (!isPinned(allowed, href)) throw new EndpointViolation(new URL(href).origin, shown(allowed));
}

function hrefOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

export function pinnedFetch(allowed: string[] | null, inner: typeof fetch = fetch): typeof fetch {
  const rules = rulesOf(allowed);
  const names = shown(allowed);
  const guarded = async (input: RequestInfo | URL, init?: RequestInit, hops = 0): Promise<Response> => {
    const href = hrefOf(input);
    const origin = new URL(href).origin;
    if (!matches(rules, href)) throw new EndpointViolation(origin, names);
    // Never follow a redirect to another origin with the credential attached.
    const response = await inner(input, { ...init, redirect: 'manual' });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) return response;
    const target = new URL(location, href);
    if (!matches(rules, target.href)) throw new EndpointViolation(target.origin, names);
    if (hops >= MAX_REDIRECTS) throw new Error(`Too many redirects from ${origin}`);
    // 303 (and 301/302 after a POST, as browsers do) continue as a GET without the body.
    const asGet =
      response.status === 303 || ((response.status === 301 || response.status === 302) && init?.method === 'POST');
    const next = asGet ? { ...init, method: 'GET', body: undefined } : init;
    return guarded(target.href, next, hops + 1);
  };
  return ((input: RequestInfo | URL, init?: RequestInit) => guarded(input, init)) as typeof fetch;
}
