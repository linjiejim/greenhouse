import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing.js';
import { startFakeMcpServer, type FakeMcpServer } from '../../connectors/__tests__/fake-mcp-server.js';
let server: FakeMcpServer | undefined;
afterEach(async () => {
  await server?.close();
});

describe('external app data as its viewer', () => {
  it('uses only read-only tools, isolates the cache per viewer and denies a disconnected viewer immediately', async () => {
    server = await startFakeMcpServer({ apiKey: { value: 'external-card-key', header: 'X-Key' } });
    const app = createTestApp({ NODE_ENV: 'development' });
    const admin = await app.member('admin');
    const viewer = await app.member();
    const connectors = app.services.connectors;
    const connector = await connectors.create(admin.id, {
      slug: 'card-desk',
      name: 'Card desk',
      url: server.url,
      auth_mode: 'per_member',
      auth_header: 'X-Key',
      read_only_tools: ['search_docs'],
    });
    await connectors.connectKey(admin.id, { connector_id: connector.id, kind: 'connector', key: 'external-card-key' });
    const base = await app.services.tables.create(admin.id, { name: 'External' });
    await app.services.tables.share(admin.id, base.id, { items: [{ type: 'member', id: viewer.id, role: 'viewer' }] });
    const draft = await app.services.apps.create(admin.id, { base_id: base.id, name: 'External', description: '' });
    const saved = await app.services.apps.save(admin.id, draft.app.id, {
      revision: draft.revision,
      name: 'External',
      description: '',
      spec: {
        roles: [],
        pages: [
          {
            id: 'home',
            name: 'Home',
            cards: [
              {
                id: 'external',
                title: 'External',
                kind: 'external',
                source: { connector: connector.slug, tool: 'search_docs', arguments: { query: 'card-data' } },
                map: { kind: 'number', value: '/total' },
              },
              {
                id: 'unsafe',
                title: 'Unsafe',
                kind: 'external',
                source: { connector: connector.slug, tool: 'create_ticket', arguments: { title: 'Must never write' } },
                map: { kind: 'number', value: '' },
              },
            ],
          },
        ],
      },
    });
    await app.services.apps.publish(admin.id, draft.app.id, {
      revision: saved.revision,
      notes: '',
      audience: [{ principal_type: 'member', principal_id: viewer.id, role: 'use' }],
    });
    const read = (member: string) => app.services.apps.card(member, draft.app.id, { version: 1, card: 'external' });
    expect(await read(admin.id)).toMatchObject({ kind: 'chart', data: { value: 42 } });
    const count = server.requests.length;
    await read(admin.id);
    expect(server.requests.length).toBe(count);
    await expect(read(viewer.id)).rejects.toMatchObject({ status: 403 });
    const own = await connectors.connectKey(viewer.id, {
      connector_id: connector.id,
      kind: 'connector',
      key: 'external-card-key',
    });
    const before = server.requests.length;
    expect(await read(viewer.id)).toMatchObject({ kind: 'chart', data: { value: 42 } });
    expect(server.requests.length).toBeGreaterThan(before);
    await expect(app.services.apps.card(viewer.id, draft.app.id, { version: 1, card: 'unsafe' })).rejects.toMatchObject(
      { status: 403 },
    );
    expect(server.tickets).toEqual([]);
    await connectors.disconnect(viewer.id, own.id);
    await expect(read(viewer.id)).rejects.toMatchObject({ status: 403 });
    await app.services.tables.share(admin.id, base.id, { items: [] });
    await expect(read(viewer.id)).rejects.toMatchObject({ status: 404 });
  });
});
