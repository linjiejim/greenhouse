/** The shared API client's connector calls against the real app: the same calls the web app makes. */

import { afterEach, describe, expect, it } from 'vitest';
import type { TokenPair } from '@greenhouse/contract';
import { createApiClient } from '@greenhouse/contract/client';
import { TEST_PASSWORD } from '../../../testing.js';
import { catalogEntry, connectorApp } from './setup.js';
import { startFakeMcpServer, type FakeMcpServer } from './fake-mcp-server.js';

const servers: FakeMcpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('the API client', () => {
  it('reaches every connector and connection call', async () => {
    const open = await startFakeMcpServer();
    const keyed = await startFakeMcpServer({ apiKey: { value: 'key-0000777', header: 'X-Key' } });
    const signIn = await startFakeMcpServer({ oauth: {} });
    servers.push(open, keyed, signIn);
    const { app, admin, lin } = await connectorApp({ connectors: { catalog: () => [catalogEntry(open.url)] } });
    const clientFor = async (email: string) => {
      let stored: TokenPair | null = null;
      const client = createApiClient({
        baseUrl: '',
        tokens: { get: () => stored, set: (tokens) => (stored = tokens) },
        fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
      });
      await client.auth.login(email, TEST_PASSWORD);
      return client;
    };
    const asAdmin = await clientFor(admin.email);
    const asLin = await clientFor(lin.email);

    expect((await asAdmin.admin.connectors.catalog()).items[0]).toMatchObject({ id: 'test.example/desk' });
    expect(await asAdmin.admin.connectors.probe(keyed.url)).toMatchObject({ auth: 'key' });
    const desk = await asAdmin.admin.connectors.create({ catalog_id: 'test.example/desk' });
    const own = await asAdmin.admin.connectors.create({
      slug: 'own',
      name: 'Own desk',
      url: keyed.url,
      auth_mode: 'per_member',
      auth_header: 'X-Key',
    });
    const oauth = await asAdmin.admin.connectors.create({
      slug: 'sso',
      name: 'SSO desk',
      url: signIn.url,
      auth_mode: 'oauth',
    });
    expect((await asAdmin.admin.connectors.list()).items.map((item) => item.slug)).toEqual(['desk', 'own', 'sso']);
    expect((await asAdmin.admin.connectors.get(desk.id)).tools).toHaveLength(8);
    expect((await asAdmin.admin.connectors.update(desk.id, { allowed_tools: ['lookup_order'] })).allowed_tools).toEqual(
      ['lookup_order'],
    );
    expect((await asAdmin.admin.connectors.refresh(desk.id)).last_error).toBeNull();
    expect(await asAdmin.admin.connectors.test(desk.id)).toMatchObject({ ok: true });
    await expect(asLin.admin.connectors.list()).rejects.toMatchObject({ status: 403 });

    const mine = await asLin.me.connections.list();
    expect(mine.connectors.map((entry) => [entry.slug, entry.needs_connection])).toEqual([
      ['desk', false],
      ['own', true],
      ['sso', true],
    ]);
    await expect(asLin.me.connections.connect({ connector_id: own.id, key: 'wrong-key' })).rejects.toMatchObject({
      status: 400,
      code: 'key_rejected',
    });
    const connection = await asLin.me.connections.connect({ connector_id: own.id, key: 'key-0000777' });
    expect((await asLin.me.connections.test(connection.id)).ok).toBe(true);
    const started = await asLin.me.connections.startOAuth(oauth.id);
    const consent = await fetch(started.authorization_url, { redirect: 'manual' });
    const back = await app.request(consent.headers.get('location')!.replace('http://greenhouse.test', ''));
    const handed = new URLSearchParams(back.headers.get('location')!.split('?')[1]);
    const signedIn = await asLin.me.connections.finishOAuth({
      state: handed.get('oauth_state')!,
      code: handed.get('oauth_code')!,
    });
    expect(signedIn).toMatchObject({ status: 'active', connector: { slug: 'sso' } });
    expect((await asLin.me.connections.list()).items).toHaveLength(2);
    await asLin.me.connections.remove(connection.id);
    await asAdmin.admin.connectors.remove(oauth.id);
    expect((await asLin.me.connections.list()).items).toEqual([]);
  });
});
