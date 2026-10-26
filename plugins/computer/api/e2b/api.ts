/**
 * The control plane of an E2B-protocol provider, plain HTTP (ported from the v2
 * line, packages/providers/src/sandbox/e2b/api.ts — the endpoints the E2B SDK
 * uses; v1 of the bots era ran them in production). Kept: create, connect,
 * renew, kill. Dropped: listing by metadata, pause / resume, templates and
 * network rewrites — a member's computer here is created on first use and
 * killed when it stops, nothing is kept between sessions.
 *
 * The API key goes in `X-API-Key`, only to `https://api.<domain>`; failures come
 * back as one short ProviderRequestError that keeps the HTTP status and never
 * repeats the key.
 */

import { ProviderRequestError, readJson, send, type CallContext } from './http.js';

const CONTROL_TIMEOUT_MS = 30_000;
/** Creating a computer boots a microVM. */
const LIFECYCLE_TIMEOUT_MS = 120_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

const HINTS: Readonly<Record<number, string>> = {
  401: 'Check the E2B API key.',
  403: 'Check the E2B API key and the account plan.',
  404: 'Check the E2B domain and template.',
};

/** What creating or connecting to a sandbox returns: how to reach it. */
export interface Connected {
  sandboxID: string;
  /** Where its ports are served; the API's domain when absent. */
  domain?: string | null;
  /** For envd, the provider's agent in the sandbox (X-Access-Token). */
  envdAccessToken?: string;
  envdVersion?: string;
}

export interface CreateSandbox {
  templateID: string;
  /** Seconds until the provider kills it unless renewed. */
  timeout: number;
  autoPause: boolean;
  metadata: Record<string, string>;
  network: { allowPublicTraffic: boolean; denyOut: string[] };
}

export type E2bApi = ReturnType<typeof createE2bApi>;

export function createE2bApi(domain: string, apiKey: string, fetchImpl: typeof fetch) {
  const base = `https://api.${domain}`;

  const context = (label: string, timeoutMs: number): CallContext => ({
    label: `${label} at ${domain}`,
    secrets: [apiKey],
    hints: HINTS,
    timeoutMs,
  });

  const path = (id: string) => {
    if (!ID.test(id)) throw new ProviderRequestError(`"${id.slice(0, 80)}" is not a sandbox id.`);
    return encodeURIComponent(id);
  };

  /** One request; null when the status is one of `absent` (a 404 that means "not there"). */
  async function request(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    label: string,
    options: { body?: unknown; timeoutMs?: number; absent?: number[] } = {},
  ): Promise<Response | null> {
    const headers: Record<string, string> = { 'X-API-Key': apiKey, Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await send(
        fetchImpl,
        `${base}${url}`,
        { method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) },
        context(label, options.timeoutMs ?? CONTROL_TIMEOUT_MS),
      );
    } catch (error) {
      const status = error instanceof ProviderRequestError ? error.statusCode : undefined;
      if (status !== undefined && options.absent?.includes(status)) return null;
      throw error;
    }
  }

  const done = async (response: Response | null) => {
    await response?.body?.cancel().catch(() => undefined);
  };

  return {
    async create(body: CreateSandbox): Promise<Connected> {
      const response = (await request('POST', '/v2/sandboxes', 'Creating the computer', {
        body,
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
      }))!;
      return readJson<Connected>(response, { label: `Creating the computer at ${domain}` });
    },

    /** How to reach a running sandbox (extends its timeout); null when it is gone. */
    async connect(id: string, timeoutSeconds: number): Promise<Connected | null> {
      const response = await request('POST', `/v2/sandboxes/${path(id)}/connect`, 'Reaching the computer', {
        body: { timeout: timeoutSeconds },
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
        absent: [404],
      });
      return response ? readJson<Connected>(response, { label: `Reaching the computer at ${domain}` }) : null;
    },

    /** Deletes the sandbox and everything in it; a missing one is not an error. */
    async kill(id: string): Promise<void> {
      await done(await request('DELETE', `/sandboxes/${path(id)}`, 'Stopping the computer', { absent: [404] }));
    },

    /** The provider kills the sandbox this many seconds from now unless renewed again. False when it is gone. */
    async setTimeout(id: string, seconds: number): Promise<boolean> {
      const response = await request('POST', `/sandboxes/${path(id)}/timeout`, 'Renewing the computer', {
        body: { timeout: seconds },
        absent: [404],
      });
      await done(response);
      return response !== null;
    },
  };
}
