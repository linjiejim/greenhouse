/**
 * The control plane of an E2B-protocol provider (E2B, PPIO …), plain HTTP: the endpoints the
 * E2B SDK 2.55 uses, which v1 ran in production. The API key goes in `X-API-Key`, only to
 * `https://api.<domain>`; failures come back as one short ProviderRequestError that keeps the
 * HTTP status and never repeats the key.
 */

import { ProviderRequestError, readJson, send, type CallContext } from '../../http.js';

const CONTROL_TIMEOUT_MS = 30_000;
/** Creating, resuming and pausing a computer: pausing writes its memory out (seconds per GB). */
const LIFECYCLE_TIMEOUT_MS = 180_000;
const LIST_PAGE = 100;
const LIST_PAGES = 20;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

const HINTS: Readonly<Record<number, string>> = {
  401: 'Check the API key.',
  403: 'Check the API key and the account plan.',
  404: 'Check the domain and the template.',
};

/** A sandbox as the list and detail endpoints describe it (only what the adapter reads). */
export interface SandboxInfo {
  sandboxID: string;
  templateID?: string;
  /** running | paused (a provider may report a transition in between). */
  state?: string;
  metadata?: Record<string, string>;
  /** What the provider does when the timeout passes; only the detail endpoint says. */
  lifecycle?: { onTimeout?: string; autoResume?: boolean };
}

/** What creating or connecting to a sandbox returns: how to reach it. */
export interface Connected {
  sandboxID: string;
  /** Where its ports are served; the API's domain when absent. */
  domain?: string | null;
  /** For envd, the provider's agent in the sandbox (X-Access-Token). */
  envdAccessToken?: string;
  /** For every other port: the edge refuses a request without it while public traffic is off. */
  trafficAccessToken?: string | null;
  envdVersion?: string;
}

export interface TemplateRow {
  templateID: string;
  names?: string[];
  aliases?: string[];
  /** The last successful build; empty while the first one runs or after it failed. */
  buildID?: string;
  buildStatus?: string;
}

export interface CreateSandbox {
  templateID: string;
  timeout: number;
  autoPause: boolean;
  autoResume: { enabled: boolean };
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

  const json = <T>(response: Response, label: string) => readJson<T>(response, { label: `${label} at ${domain}` });

  const done = async (response: Response | null) => {
    await response?.body?.cancel().catch(() => undefined);
  };

  return {
    /** Running and paused sandboxes whose metadata has every one of these pairs. */
    async list(metadata: Record<string, string>): Promise<SandboxInfo[]> {
      const items: SandboxInfo[] = [];
      let next: string | null = null;
      for (let page = 0; page < LIST_PAGES; page++) {
        const query = new URLSearchParams({ metadata: new URLSearchParams(metadata).toString() });
        query.append('state', 'running');
        query.append('state', 'paused');
        query.set('limit', String(LIST_PAGE));
        if (next) query.set('nextToken', next);
        const response = (await request('GET', `/v2/sandboxes?${query}`, 'Listing the computers'))!;
        const rows = await json<SandboxInfo[]>(response, 'Listing the computers');
        if (Array.isArray(rows)) items.push(...rows);
        next = response.headers.get('x-next-token');
        if (!next || !Array.isArray(rows) || !rows.length) break;
      }
      return items;
    },

    /** null when the sandbox does not exist (any more). */
    async info(id: string): Promise<SandboxInfo | null> {
      const response = await request('GET', `/sandboxes/${path(id)}`, 'Reading the computer', { absent: [404] });
      return response ? json<SandboxInfo>(response, 'Reading the computer') : null;
    },

    async create(body: CreateSandbox): Promise<Connected> {
      const response = (await request('POST', '/v2/sandboxes', 'Creating the computer', {
        body,
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
      }))!;
      return json<Connected>(response, 'Creating the computer');
    },

    /** Resumes a paused sandbox (a running one only gets its timeout extended); null when it is gone. */
    async connect(id: string, timeoutSeconds: number): Promise<Connected | null> {
      const response = await request('POST', `/v2/sandboxes/${path(id)}/connect`, 'Waking the computer', {
        body: { timeout: timeoutSeconds },
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
        absent: [404],
      });
      return response ? json<Connected>(response, 'Waking the computer') : null;
    },

    /** Memory and disk are kept; a sandbox already paused or gone is not an error. */
    async pause(id: string): Promise<void> {
      await done(
        await request('POST', `/sandboxes/${path(id)}/pause`, 'Pausing the computer', {
          body: {},
          timeoutMs: LIFECYCLE_TIMEOUT_MS,
          absent: [404, 409],
        }),
      );
    },

    /** Deletes the sandbox and everything in it; a missing one is not an error. */
    async kill(id: string): Promise<void> {
      await done(await request('DELETE', `/sandboxes/${path(id)}`, 'Removing the computer', { absent: [404] }));
    },

    /** The sandbox pauses itself this many seconds from now unless renewed again. */
    async setTimeout(id: string, seconds: number): Promise<void> {
      await done(
        await request('POST', `/sandboxes/${path(id)}/timeout`, 'Renewing the computer', {
          body: { timeout: seconds },
          absent: [404],
        }),
      );
    },

    async templates(): Promise<TemplateRow[]> {
      const response = (await request('GET', '/templates', 'Listing the templates'))!;
      const rows = await json<TemplateRow[]>(response, 'Listing the templates');
      return Array.isArray(rows) ? rows : [];
    },
  };
}

/** The template a name or id refers to: its id, one of its names (`team/name` too) or an alias. */
export function findTemplate(rows: readonly TemplateRow[], name: string): TemplateRow | undefined {
  const matches = (value: string) => value === name || value.endsWith(`/${name}`);
  return rows.find(
    (row) => row.templateID === name || (row.names ?? []).some(matches) || (row.aliases ?? []).some(matches),
  );
}
