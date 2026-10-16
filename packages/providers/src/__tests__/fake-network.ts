import { vi } from 'vitest';
import { pinnedFetch } from '../pinned-fetch.js';
import type { Capability, ProviderAdapter } from '../types.js';

export const KEY = 'sk-test-secret-0123456789';

export type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A client whose requests reach `handler` only through the pinned fetch the API gives real instances. */
export function connect<C extends Capability, Config>(
  adapter: ProviderAdapter<C, Config>,
  rawConfig: Record<string, unknown>,
  handler: Handler,
  secrets: Record<string, string> = { apiKey: KEY },
) {
  const config = adapter.configSchema.parse(rawConfig);
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {}));
  const client = adapter.create({
    config,
    secrets,
    fetch: pinnedFetch(adapter.endpoints(config), fake as unknown as typeof fetch),
  });
  return { client, config, fake };
}

/** The error a call failed with; a call that succeeds fails the test. */
export async function rejection(call: Promise<unknown>): Promise<Error & { statusCode?: number }> {
  try {
    await call;
  } catch (error) {
    return error as Error & { statusCode?: number };
  }
  throw new Error('Expected the call to fail');
}

/** The nth request the fake network received, with a JSON body parsed when there is one. */
export function sent(fake: { mock: { calls: unknown[][] } }, index = 0) {
  const [url, init] = fake.mock.calls[index] as [string, RequestInit];
  return {
    url: new URL(url),
    init,
    headers: new Headers(init.headers),
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  };
}
