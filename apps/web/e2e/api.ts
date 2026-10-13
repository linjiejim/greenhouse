/**
 * Calls the browser tests make on the side: the API as one of the signed-in people (to set up
 * what a page needs), and an outside app's side of OAuth and MCP (register, authorize, trade a
 * code, call /api/mcp), which the web app never does itself.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { APIRequestContext } from '@playwright/test';
import { E2E, PEOPLE } from './env';

export const WEB = `http://127.0.0.1:${E2E.webPort}`;
const API = `http://127.0.0.1:${E2E.apiPort}`;

/** One of the MCP servers fake-mcp.mjs serves beside the fake model. */
export const mcpUrl = (path: 'open' | 'key' | 'signin') => `http://127.0.0.1:${E2E.llmPort}/mcp/${path}`;
/** The key fake-mcp.mjs takes at /mcp/key (MCP_KEY). */
export const MCP_KEY = 'e2e-good-key';

/** The access token e2e/auth.setup.ts saved for this person. */
function tokenOf(person: keyof typeof PEOPLE): string {
  const state = JSON.parse(readFileSync(new URL(`.auth/${person}.json`, import.meta.url), 'utf8')) as {
    origins: { localStorage: { value: string }[] }[];
  };
  return (JSON.parse(state.origins[0]!.localStorage[0]!.value) as { access_token: string }).access_token;
}

/** The API as this person; the JSON answer, or a thrown error with the server's. */
export async function apiAs<T = Record<string, unknown>>(
  request: APIRequestContext,
  person: keyof typeof PEOPLE,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await request.fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenOf(person)}` },
    ...(data === undefined ? {} : { data }),
  });
  if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()} ${await response.text()}`);
  return (response.status() === 204 ? {} : await response.json()) as T;
}

/** Where the outside app of these tests wants the browser back; tests answer it with page.route. */
export const APP_CALLBACK = `${WEB}/e2e-app/callback`;

/** An outside app registers itself (RFC 7591), as an MCP client would. */
export async function registerApp(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post(`${API}/oauth/register`, {
    data: { client_name: name, redirect_uris: [APP_CALLBACK] },
  });
  return ((await response.json()) as { client_id: string }).client_id;
}

/** /oauth/authorize with PKCE: where it sends the browser (the consent page), and the verifier for the code. */
export async function authorize(request: APIRequestContext, clientId: string, scope?: string) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: APP_CALLBACK,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'e2e-state',
    ...(scope ? { scope } : {}),
  });
  const response = await request.get(`${API}/oauth/authorize?${query}`, { maxRedirects: 0 });
  return { location: response.headers().location ?? '', verifier };
}

/** The app trades its code for tokens. */
export async function exchangeCode(request: APIRequestContext, clientId: string, code: string, verifier: string) {
  const response = await request.post(`${API}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: APP_CALLBACK,
    },
  });
  return (await response.json()) as { access_token: string; scope: string };
}

/** A machine client asks for a token with its secret. */
export function clientCredentials(request: APIRequestContext, clientId: string, secret: string) {
  return request.post(`${API}/oauth/token`, {
    form: { grant_type: 'client_credentials', client_id: clientId, client_secret: secret },
  });
}

/** The first MCP request a client makes, with this bearer token: 200 when the token works, 401 when not. */
export function mcpInitialize(request: APIRequestContext, token: string) {
  return request.post(`${API}/api/mcp`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
    },
  });
}
