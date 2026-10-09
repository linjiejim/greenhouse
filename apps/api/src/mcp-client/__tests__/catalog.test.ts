/**
 * The official connector catalog (`connectors/*.json`) and the MCP Registry
 * mapping (spec 20261009-mcp-connectors D11). Every catalog file must parse —
 * this is the check a contribution PR has to pass — and the address probe must
 * tell a public server, a key-protected one and an OAuth one apart.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECTOR_CATALOG_META_KEY } from '@greenhouse/types/mcp-servers';
import { loadCatalog, probeServerAuth, REGISTRY_SERVER_SCHEMA, toRegistryResult } from '../catalog.js';
import { startMcpTestServer, type McpTestServer } from './fixture-server.js';

describe('the official catalog', () => {
  const { entries, errors } = loadCatalog();

  it('every file parses, with unique ids and slugs', () => {
    expect(errors).toEqual([]);
    expect(entries.length).toBeGreaterThanOrEqual(10);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(new Set(entries.map((e) => e.slug)).size).toBe(entries.length);
  });

  it('covers every way a member can authenticate', () => {
    const modes = new Set(entries.map((e) => e.auth.mode));
    expect(modes).toEqual(new Set(['none', 'oauth', 'per_user']));
  });

  it('every per-member entry tells members what to paste, in both languages', () => {
    for (const entry of entries.filter((e) => e.auth.mode === 'per_user')) {
      expect(entry.auth.help, entry.id).toBeTruthy();
      expect(entry.auth.help_zh, entry.id).toBeTruthy();
      expect(Boolean(entry.auth.header) !== Boolean(entry.auth.query_param), entry.id).toBe(true);
    }
  });

  it('never vouches a tool read-only on an OAuth or key server it could not call', () => {
    for (const entry of entries.filter((e) => e.verification.level !== 'call')) {
      expect(entry.read_only_tools, entry.id).toEqual([]);
    }
  });
});

describe('catalog file validation', () => {
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
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  const meta = valid._meta[CONNECTOR_CATALOG_META_KEY];

  write('a-valid.json', valid);
  write('b-http.json', {
    ...valid,
    name: 'com.example/b',
    remotes: [{ type: 'streamable-http', url: 'http://x.example/mcp' }],
  });
  write('c-both.json', {
    ...valid,
    name: 'com.example/c',
    _meta: {
      [CONNECTOR_CATALOG_META_KEY]: {
        ...meta,
        slug: 'c',
        auth: { mode: 'per_user', header: 'X', query_param: 'k', help: 'h', help_zh: 'h', zero_config: true },
      },
    },
  });
  write('d-long.json', { ...valid, name: 'com.example/d', description: 'x'.repeat(101) });
  write('e-nometa.json', { ...valid, name: 'com.example/e', _meta: {} });
  write('f-dup.json', valid);

  it('reports each broken file by name and keeps only the good ones', () => {
    const { entries, errors } = loadCatalog(dir);
    expect(entries.map((e) => e.id)).toEqual(['com.example/mcp', 'com.example/mcp']);
    expect(errors.some((e) => e.startsWith('b-http.json') && e.includes('https'))).toBe(true);
    expect(errors.some((e) => e.startsWith('c-both.json'))).toBe(true);
    expect(errors.some((e) => e.startsWith('d-long.json'))).toBe(true);
    expect(errors.some((e) => e.startsWith('e-nometa.json'))).toBe(true);
    expect(errors).toContain('duplicate catalog id "com.example/mcp"');
  });
});

describe('MCP Registry results', () => {
  it('keeps active remote servers, drops templates, and points at the catalog when it has the server', () => {
    const catalogIds = new Set(['app.linear/linear']);
    const linear = toRegistryResult(
      {
        server: {
          name: 'app.linear/linear',
          version: '1.0.1',
          remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
        },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
      },
      catalogIds,
    );
    expect(linear).toMatchObject({ catalog_id: 'app.linear/linear', remotes: [{ transport: 'streamable_http' }] });

    const lookalike = toRegistryResult(
      {
        server: {
          name: 'io.github.someone/linear-broker',
          version: '1.0.0',
          remotes: [
            {
              type: 'sse',
              url: 'https://broker.example/api/mcp',
              headers: [{ name: 'payment-signature', isSecret: true }],
            },
          ],
        },
      },
      catalogIds,
    );
    expect(lookalike).toMatchObject({
      catalog_id: null,
      remotes: [{ transport: 'sse', headers: [{ name: 'payment-signature', secret: true }] }],
    });

    expect(
      toRegistryResult(
        {
          server: {
            name: 'a/b',
            version: '1',
            remotes: [{ type: 'streamable-http', url: 'https://{tenant}.x.io/mcp' }],
          },
        },
        catalogIds,
      ),
    ).toBeNull();
    expect(
      toRegistryResult(
        {
          server: { name: 'a/c', version: '1', remotes: [{ type: 'streamable-http', url: 'https://x.io/mcp' }] },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } },
        },
        catalogIds,
      ),
    ).toBeNull();
    expect(toRegistryResult({ server: { name: 'a/d', version: '1', packages: [] } as never }, catalogIds)).toBeNull();
    // Older versions are filtered here (the Registry's own version=latest filter is too slow to use).
    expect(
      toRegistryResult(
        {
          server: { name: 'a/e', version: '1', remotes: [{ type: 'streamable-http', url: 'https://x.io/mcp' }] },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: false } },
        },
        catalogIds,
      ),
    ).toBeNull();
  });
});

describe('probeServerAuth', () => {
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

  it('tells a public, a key-protected and an OAuth server apart', async () => {
    expect(await probeServerAuth(open.url, 'streamable_http')).toEqual({ auth: 'none', tool_count: 5 });
    expect(await probeServerAuth(keyed.url, 'streamable_http')).toEqual({ auth: 'key' });
    expect(await probeServerAuth(oauth.url, 'streamable_http')).toMatchObject({
      auth: 'oauth',
      dynamic_registration: true,
      metadata_document: false,
      scopes: ['tickets'],
    });
  });

  it('says so when nothing answers', async () => {
    expect(await probeServerAuth('http://127.0.0.1:9/mcp', 'streamable_http')).toMatchObject({ auth: 'unknown' });
  });
});
