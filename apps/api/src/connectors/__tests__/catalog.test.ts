/**
 * The official connector catalog (`connectors/*.json`) — every file must parse
 * (the check a contribution PR has to pass) — and the address probe must tell
 * a public server, a key-protected one and an OAuth one apart.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECTOR_CATALOG_META_KEY } from '@greenhouse/types/connectors';
import { loadCatalog, probeConnectorAuth, REGISTRY_SERVER_SCHEMA } from '../catalog.js';
import { startMcpTestServer, type McpTestServer } from './fixture-server.js';

describe('the official catalog', () => {
  const { entries, errors } = loadCatalog();

  it('every file parses, with unique ids and slugs', () => {
    expect(errors).toEqual([]);
    expect(entries.length).toBe(13);
    expect(new Set(entries.map((e) => e.slug)).size).toBe(entries.length);
  });

  it('maps the 1.x auth vocabulary onto per-member key / OAuth', () => {
    const kinds = new Set(entries.map((e) => `${e.auth.mode}:${e.auth.kind ?? '-'}`));
    expect(kinds).toEqual(new Set(['none:-', 'per_member:oauth', 'per_member:key']));
    for (const entry of entries.filter((e) => e.auth.kind === 'key')) {
      expect(entry.auth.help && entry.auth.help_zh, entry.id).toBeTruthy();
      expect(Boolean(entry.auth.header) !== Boolean(entry.auth.query_param), entry.id).toBe(true);
    }
  });

  it('never vouches a tool read-only on a server it could not call', () => {
    for (const entry of entries.filter((e) => e.verification.level !== 'call')) {
      expect(entry.read_only_tools, entry.id).toEqual([]);
    }
  });

  it('rejects a plain-http remote and a key placed both ways', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-catalog-'));
    const valid = {
      $schema: REGISTRY_SERVER_SCHEMA,
      name: 'com.example/mcp',
      title: 'Example',
      description: 'An example server.',
      version: '1.0.0',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
      _meta: {
        [CONNECTOR_CATALOG_META_KEY]: {
          slug: 'example',
          category: 'other',
          description_zh: '示例服务器。',
          auth: { mode: 'none', zero_config: true },
          verification: { level: 'call', date: '2026-10-09' },
        },
      },
    };
    const meta = valid._meta[CONNECTOR_CATALOG_META_KEY];
    writeFileSync(join(dir, 'a.json'), JSON.stringify(valid));
    writeFileSync(
      join(dir, 'b.json'),
      JSON.stringify({
        ...valid,
        name: 'com.example/b',
        remotes: [{ type: 'streamable-http', url: 'http://x.example/mcp' }],
      }),
    );
    writeFileSync(
      join(dir, 'c.json'),
      JSON.stringify({
        ...valid,
        name: 'com.example/c',
        _meta: {
          [CONNECTOR_CATALOG_META_KEY]: {
            ...meta,
            slug: 'c',
            auth: { mode: 'per_user', header: 'X-Key', query_param: 'key', help: 'h', help_zh: 'h', zero_config: true },
          },
        },
      }),
    );
    const result = loadCatalog(dir);
    expect(result.entries.map((e) => e.slug)).toEqual(['example']);
    expect(result.errors).toHaveLength(2);
  });
});

describe('probeConnectorAuth', () => {
  let open: McpTestServer;
  let keyed: McpTestServer;
  let oauth: McpTestServer;
  beforeAll(async () => {
    open = await startMcpTestServer();
    keyed = await startMcpTestServer({ apiKey: { value: 'k', header: 'x-api-key' } });
    oauth = await startMcpTestServer({ oauth: {} });
  });
  afterAll(async () => {
    await Promise.all([open.close(), keyed.close(), oauth.close()]);
  });

  const policy = { privateHost: null };
  it('tells none, key and OAuth apart', async () => {
    expect(await probeConnectorAuth(open.url, 'streamable_http', policy)).toEqual({ auth: 'none', tool_count: 6 });
    expect(await probeConnectorAuth(keyed.url, 'streamable_http', policy)).toEqual({ auth: 'key' });
    expect(await probeConnectorAuth(oauth.url, 'streamable_http', policy)).toMatchObject({
      auth: 'oauth',
      dynamic_registration: true,
      scopes: ['tickets'],
    });
  });

  it('says why an address cannot be reached', async () => {
    expect(await probeConnectorAuth('http://127.0.0.1:9/mcp', 'streamable_http', policy)).toMatchObject({
      auth: 'unknown',
    });
  });
});
