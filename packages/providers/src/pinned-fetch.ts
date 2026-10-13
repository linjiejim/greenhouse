/**
 * A credential is only ever sent to the endpoint it was configured for. Every adapter gets
 * a fetch that refuses any other origin, whatever URL the SDK or a redirect produces.
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

function hrefOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

export function pinnedFetch(allowed: string[] | null, inner: typeof fetch = fetch): typeof fetch {
  const origins = new Set((allowed ?? []).map((endpoint) => new URL(endpoint).origin));
  const guarded = async (input: RequestInfo | URL, init?: RequestInit, hops = 0): Promise<Response> => {
    const href = hrefOf(input);
    const origin = new URL(href).origin;
    if (!origins.has(origin)) throw new EndpointViolation(origin, [...origins]);
    // Never follow a redirect to another origin with the credential attached.
    const response = await inner(input, { ...init, redirect: 'manual' });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) return response;
    const target = new URL(location, href);
    if (!origins.has(target.origin)) throw new EndpointViolation(target.origin, [...origins]);
    if (hops >= MAX_REDIRECTS) throw new Error(`Too many redirects from ${origin}`);
    // 303 (and 301/302 after a POST, as browsers do) continue as a GET without the body.
    const asGet =
      response.status === 303 || ((response.status === 301 || response.status === 302) && init?.method === 'POST');
    const next = asGet ? { ...init, method: 'GET', body: undefined } : init;
    return guarded(target.href, next, hops + 1);
  };
  return ((input: RequestInfo | URL, init?: RequestInit) => guarded(input, init)) as typeof fetch;
}
