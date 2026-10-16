/** Test support for external access: a registered client, the browser round trip and the token calls. */

import { createHash, randomBytes } from 'node:crypto';
import type { OAuthScope } from '@greenhouse/contract';
import type { createTestApp } from '../../../testing.js';

export const ISSUER = 'http://greenhouse.test';
export const RESOURCE = `${ISSUER}/api/mcp`;
export const REDIRECT = 'http://127.0.0.1:33418/callback';

type TestApp = ReturnType<typeof createTestApp>;
type Member = Awaited<ReturnType<TestApp['member']>>;

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function parse(response: Response) {
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as any) : null };
}

/** A form POST, the way OAuth clients send them. */
export async function postForm(t: TestApp, path: string, fields: Record<string, string>, headers = {}) {
  return parse(
    await t.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

export async function register(t: TestApp, body: Record<string, unknown> = {}) {
  return parse(
    await t.app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT], ...body }),
    }),
  );
}

/** Where /oauth/authorize sends the browser. */
export async function authorize(t: TestApp, params: Record<string, string>) {
  const response = await t.app.request(`/oauth/authorize?${new URLSearchParams(params)}`);
  return { status: response.status, location: response.headers.get('location') ?? '' };
}

/** The query of a consent-page URL (`…/#/oauth/consent?…`) or of a client redirect. */
export function queryOf(location: string): URLSearchParams {
  return new URL(location.replace('/#/', '/')).searchParams;
}

export function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-12345',
    resource: RESOURCE,
    ...extra,
  };
}

/**
 * The whole interactive flow for a member: register (unless a client id is given), authorize,
 * approve on the consent page, exchange the code. Returns the client, the code's verifier and the tokens.
 */
export async function connect(
  t: TestApp,
  member: Member,
  options: { clientId?: string; scope?: string; approve?: OAuthScope[] } = {},
) {
  const clientId = options.clientId ?? (await register(t)).body.client_id;
  const { verifier, challenge } = pkce();
  const start = await authorize(t, authorizeParams(clientId, challenge, options.scope ? { scope: options.scope } : {}));
  const request = queryOf(start.location).get('request');
  if (!request) throw new Error(`No consent request in ${start.location}`);
  const decision = await t.call('POST', '/api/oauth/consent', {
    token: member.token,
    body: { request, decision: 'approve', ...(options.approve ? { scopes: options.approve } : {}) },
  });
  if (decision.status !== 200) throw new Error(`Consent failed: ${JSON.stringify(decision.body)}`);
  const code = queryOf(decision.body.redirect_to).get('code')!;
  const tokens = await postForm(t, '/oauth/token', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: clientId,
    resource: RESOURCE,
  });
  if (tokens.status !== 200) throw new Error(`Token exchange failed: ${JSON.stringify(tokens.body)}`);
  return {
    clientId,
    verifier,
    code,
    tokens: tokens.body as { access_token: string; refresh_token: string; scope: string },
  };
}

/** One JSON-RPC call to /api/mcp. */
export async function mcp(t: TestApp, token: string | null, method = 'tools/list', params: unknown = {}) {
  return parse(
    await t.app.request('/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
}

/** The names of the tools a token sees. */
export async function toolNames(t: TestApp, token: string): Promise<string[]> {
  const listed = await mcp(t, token);
  if (listed.status !== 200) throw new Error(`tools/list answered ${listed.status}`);
  return (listed.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
}

/** A tool call's parsed output, and whether it was an error. */
export async function callTool(t: TestApp, token: string, name: string, args: Record<string, unknown> = {}) {
  const called = await mcp(t, token, 'tools/call', { name, arguments: args });
  if (called.status !== 200) throw new Error(`tools/call answered ${called.status}`);
  const result = called.body.result as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: result.isError === true, output: JSON.parse(result.content[0]!.text) as any };
}
