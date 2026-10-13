/** The built-in catalog (`connectors/*.json`) and the Registry mapping: run this after adding a catalog file. */

import { describe, expect, it } from 'vitest';
import { loadCatalog, toRegistryResult } from '../catalog.js';

describe('the built-in catalog', () => {
  const { entries, errors } = loadCatalog();

  it('loads every file without an error', () => {
    expect(errors).toEqual([]);
    expect(entries.length).toBeGreaterThan(5);
  });

  it('points only at https servers and gives members what they need to connect', () => {
    for (const entry of entries) {
      expect(entry.url.startsWith('https://'), entry.id).toBe(true);
      if (entry.auth.mode === 'per_member') {
        expect(entry.auth.header || entry.auth.query_param, entry.id).toBeTruthy();
        expect(entry.auth.help && entry.auth.help_zh, entry.id).toBeTruthy();
      }
    }
    expect(new Set(entries.map((entry) => entry.slug)).size).toBe(entries.length);
  });
});

describe('a Registry result', () => {
  const catalogIds = new Set(['app.linear/linear']);

  it('keeps remote servers Greenhouse can reach, and points at the catalog when it has the same one', () => {
    expect(
      toRegistryResult(
        {
          server: {
            name: 'app.linear/linear',
            version: '1.0.0',
            description: 'Linear',
            remotes: [
              { type: 'streamable-http', url: 'https://mcp.linear.app/mcp' },
              { type: 'sse', url: 'https://{tenant}.example.com/sse' },
              { type: 'stdio' },
            ],
          },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
        },
        catalogIds,
      ),
    ).toEqual({
      name: 'app.linear/linear',
      title: null,
      description: 'Linear',
      version: '1.0.0',
      website_url: null,
      remotes: [{ transport: 'streamable_http', url: 'https://mcp.linear.app/mcp', headers: [] }],
      catalog_id: 'app.linear/linear',
    });
  });

  it('drops old versions, deleted entries and local-only servers', () => {
    const server = { name: 'a/b', version: '1', remotes: [{ type: 'streamable-http', url: 'https://a.example/mcp' }] };
    const meta = (value: object) => ({ 'io.modelcontextprotocol.registry/official': value });
    expect(toRegistryResult({ server, _meta: meta({ isLatest: false }) }, catalogIds)).toBeNull();
    expect(toRegistryResult({ server, _meta: meta({ status: 'deleted' }) }, catalogIds)).toBeNull();
    expect(toRegistryResult({ server: { ...server, remotes: [{ type: 'stdio' }] } }, catalogIds)).toBeNull();
    expect(
      toRegistryResult({ server: { ...server, remotes: [{ type: 'sse', url: 'http://a.example/sse' }] } }, catalogIds),
    ).toBeNull();
  });
});
