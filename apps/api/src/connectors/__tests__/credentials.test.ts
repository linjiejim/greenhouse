/** Key placement, secret redaction (raw and URL-encoded) and the directory's per-member view. */

import { describe, expect, it } from 'vitest';
import type { McpConnectorRow } from '@greenhouse/db';
import { placeCredential, redactSecrets } from '../credentials.js';
import { _setConnectorDirectory, connectorsForUser, findConnector, toDirectoryConnector } from '../directory.js';

describe('placeCredential', () => {
  it('puts a key in a header with its prefix, or in a query parameter', () => {
    const base = {
      url: 'https://mcp.example.com/mcp?x=1',
      auth_header: null,
      auth_query_param: null,
      auth_value_prefix: 'Bearer ',
    };
    expect(placeCredential(base, 'k1')).toEqual({ url: base.url, headers: { Authorization: 'Bearer k1' } });
    expect(placeCredential({ ...base, auth_header: 'X-Api-Key', auth_value_prefix: null }, 'k1').headers).toEqual({
      'X-Api-Key': 'k1',
    });
    const query = placeCredential({ ...base, auth_query_param: 'key', auth_value_prefix: null }, 'a b/c');
    expect(query.headers).toEqual({});
    expect(new URL(query.url).searchParams.get('key')).toBe('a b/c');
  });
});

describe('redactSecrets', () => {
  it('removes the raw, percent-encoded and form-encoded forms of a secret', () => {
    const secret = 'sk+live/abc def';
    const message = `failed: ${secret} | ${encodeURIComponent(secret)} | ${new URLSearchParams({ key: secret }).toString()}`;
    const out = redactSecrets(message, [secret]);
    expect(out).not.toContain('abc');
    expect(out.match(/\*\*\*/g)?.length).toBeGreaterThanOrEqual(3);
    expect(redactSecrets('abc', ['ab'])).toBe('abc');
  });
});

function row(over: Partial<McpConnectorRow>): McpConnectorRow {
  return {
    id: 'mcc_1',
    scope: 'team',
    owner_user_id: null,
    slug: 'desk',
    name: 'Desk',
    description: null,
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable_http',
    auth_mode: 'none',
    auth_kind: null,
    auth_header: null,
    auth_query_param: null,
    auth_value_prefix: null,
    shared_secret_enc: null,
    oauth_client_enc: null,
    oauth_discovery: null,
    oauth_scope: null,
    private_network: false,
    allow_external_writes: false,
    tool_policy: {},
    vouched_read_only: [],
    tools: [
      { name: 'read', description: '', input_schema: {}, read_only: true, destructive: false },
      { name: 'write', description: '', input_schema: {}, read_only: false, destructive: false },
      { name: 'drop', description: '', input_schema: {}, read_only: false, destructive: true },
      { name: 'vouched', description: '', input_schema: {}, read_only: false, destructive: false },
    ],
    tools_refreshed_at: null,
    last_error: null,
    enabled: true,
    catalog_id: null,
    created_by: null,
    created_at: '2026-10-26T00:00:00.000Z',
    updated_at: '2026-10-26T00:00:00.000Z',
    ...over,
  };
}

describe('the directory', () => {
  it('keeps only switched-on tools: read-only (declared or vouched) by default, writes when turned on', () => {
    const entry = toDirectoryConnector(row({ vouched_read_only: ['vouched', 'drop'], tool_policy: { drop: 'on' } }));
    expect(entry.tools.map((t) => [t.name, t.kind])).toEqual([
      ['read', 'read'],
      ['drop', 'destructive'],
      ['vouched', 'read'],
    ]);
  });

  it('shows team connectors to everyone, personal ones to their owner, narrowed by an agent list', () => {
    _setConnectorDirectory([
      toDirectoryConnector(row({ id: 'mcc_t', slug: 'team-desk' })),
      toDirectoryConnector(row({ id: 'mcc_p', scope: 'personal', owner_user_id: 'u1', slug: 'notes' })),
    ]);
    expect(connectorsForUser('u1').map((c) => c.handle)).toEqual(['team-desk', 'me/notes']);
    expect(connectorsForUser('u2').map((c) => c.handle)).toEqual(['team-desk']);
    expect(connectorsForUser('u1', ['mcc_p']).map((c) => c.handle)).toEqual(['me/notes']);
    expect(connectorsForUser('u1', []).length).toBe(0);
    expect(findConnector('u2', 'me/notes')).toBeUndefined();
    expect(findConnector('u1', 'ME/notes')?.id).toBe('mcc_p');
    _setConnectorDirectory([]);
  });
});
