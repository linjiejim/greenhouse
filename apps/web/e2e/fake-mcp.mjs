/**
 * A small MCP server for the browser tests, served by the fake model's server (fake-llm.mjs):
 * JSON-RPC over streamable HTTP, stateless, JSON replies (the API's connector development mode
 * allows http://127.0.0.1). Three addresses:
 *   /mcp/open     answers anyone
 *   /mcp/key      wants a key in X-Api-Key: MCP_KEY passes, anything else gets 401
 *   /mcp/signin   wants each member's sign-in: an OAuth 2.1 authorization server at /fake-oauth
 *                 (dynamic registration, PKCE S256, rotating refresh tokens) that approves at once
 * Its authorization server lives under a path, so the other two addresses never look like
 * sign-in servers when the API probes them. Tools on all three: lookup_order (read-only),
 * create_ticket (unmarked), delete_ticket (destructive).
 */

import { createHash } from 'node:crypto';

export const MCP_KEY = 'e2e-good-key';

const TOOLS = [
  {
    name: 'lookup_order',
    description: 'Look up an order by id and say where it is.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_ticket',
    description: 'Create a support ticket.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  },
  {
    name: 'delete_ticket',
    description: 'Delete a ticket for good.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { destructiveHint: true },
  },
];

let counter = 0;
const next = (prefix) => `${prefix}_${Date.now().toString(36)}${(counter += 1)}`;
/** Codes waiting for the token endpoint, and the access and refresh tokens it gave. */
const codes = new Map();
const accessTokens = new Set();
const refreshTokens = new Set();

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

const pkce = (verifier) => createHash('sha256').update(verifier).digest('base64url');

function issue() {
  const pair = { access_token: next('at'), refresh_token: next('rt') };
  accessTokens.add(pair.access_token);
  refreshTokens.add(pair.refresh_token);
  return { ...pair, token_type: 'Bearer', expires_in: 3600, scope: 'tickets' };
}

function callTool(name, args) {
  switch (name) {
    case 'lookup_order':
      return { content: [{ type: 'text', text: `Order ${String(args.order_id)} shipped on 2026-10-01` }] };
    case 'create_ticket':
      return { content: [{ type: 'text', text: `Created ticket T-1: ${String(args.title)}` }] };
    case 'delete_ticket':
      return { content: [{ type: 'text', text: `Deleted ticket ${String(args.id)}` }] };
    default:
      return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  }
}

function rpc(message) {
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'e2e-desk', version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      return reply(callTool(message.params?.name, message.params?.arguments ?? {}));
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `No method ${message.method}` } };
  }
}

/**
 * Answers the MCP and sign-in addresses; false for anything else (the fake model answers it).
 * `origin` is this server's own address.
 */
export function handleMcp(request, response, raw, origin) {
  const url = new URL(request.url ?? '/', origin);
  const path = url.pathname;
  const issuer = `${origin}/fake-oauth`;

  if (path.startsWith('/.well-known/')) {
    if (path === '/.well-known/oauth-protected-resource/mcp/signin') {
      json(response, 200, {
        resource: `${origin}/mcp/signin`,
        authorization_servers: [issuer],
        scopes_supported: ['tickets'],
      });
    } else if (path === '/.well-known/oauth-authorization-server/fake-oauth') {
      json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['tickets'],
      });
    } else {
      json(response, 404, { error: 'not_found' });
    }
    return true;
  }

  if (path.startsWith('/fake-oauth/')) {
    const form = request.method === 'POST' ? new URLSearchParams(raw) : url.searchParams;
    if (path === '/fake-oauth/register' && request.method === 'POST') {
      const body = raw ? JSON.parse(raw) : {};
      json(response, 201, {
        client_id: next('client'),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: body.redirect_uris ?? [],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    } else if (path === '/fake-oauth/authorize' && request.method === 'GET') {
      const redirect = form.get('redirect_uri');
      if (!redirect || form.get('code_challenge_method') !== 'S256') {
        json(response, 400, { error: 'invalid_request' });
        return true;
      }
      // Approves at once, as if the member had clicked "Allow" at the provider.
      const code = next('code');
      codes.set(code, { challenge: form.get('code_challenge'), redirect });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      if (form.get('state')) back.searchParams.set('state', form.get('state'));
      response.writeHead(302, { location: back.toString() });
      response.end();
    } else if (path === '/fake-oauth/token' && request.method === 'POST') {
      if (form.get('grant_type') === 'authorization_code') {
        const pending = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!pending || pkce(form.get('code_verifier') ?? '') !== pending.challenge) {
          json(response, 400, { error: 'invalid_grant' });
        } else json(response, 200, issue());
      } else if (form.get('grant_type') === 'refresh_token' && refreshTokens.delete(form.get('refresh_token') ?? '')) {
        json(response, 200, issue());
      } else {
        json(response, 400, { error: 'invalid_grant' });
      }
    } else if (path === '/fake-oauth/revoke' && request.method === 'POST') {
      accessTokens.delete(form.get('token') ?? '');
      refreshTokens.delete(form.get('token') ?? '');
      response.writeHead(200);
      response.end();
    } else {
      json(response, 404, { error: 'not_found' });
    }
    return true;
  }

  if (!['/mcp/open', '/mcp/key', '/mcp/signin'].includes(path)) return false;
  if (path === '/mcp/key' && request.headers['x-api-key'] !== MCP_KEY) {
    json(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    return true;
  }
  if (path === '/mcp/signin') {
    const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!accessTokens.has(bearer)) {
      json(
        response,
        401,
        { error: 'invalid_token' },
        { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/signin"` },
      );
      return true;
    }
  }
  if (request.method !== 'POST') {
    // Stateless: no event stream to open, no session to end.
    response.writeHead(405);
    response.end();
    return true;
  }
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    json(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (message.id === undefined) {
    // A notification (notifications/initialized): accepted, nothing to answer.
    response.writeHead(202);
    response.end();
    return true;
  }
  json(response, 200, rpc(message));
  return true;
}
