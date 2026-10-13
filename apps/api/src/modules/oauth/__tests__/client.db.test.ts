/** The typed client's external-access calls against the real app: what the consent page and the settings use. */

import { describe, expect, it } from 'vitest';
import type { TokenPair } from '@greenhouse/contract';
import { createApiClient } from '@greenhouse/contract/client';
import { createTestApp, TEST_PASSWORD } from '../../../testing.js';
import { authorize, authorizeParams, mcp, pkce, queryOf, register, REDIRECT } from './flow.js';

function clientFor(t: ReturnType<typeof createTestApp>) {
  let stored: TokenPair | null = null;
  return createApiClient({
    baseUrl: '',
    tokens: { get: () => stored, set: (tokens) => (stored = tokens) },
    fetch: (input, init) => Promise.resolve(t.app.request(String(input), init)),
  });
}

describe('the API client for external access', () => {
  it('reads and decides a consent request, then manages grants and personal tokens', async () => {
    const t = createTestApp();
    await t.member('member', 'lin@example.com');
    const api = clientFor(t);
    await api.auth.login('lin@example.com', TEST_PASSWORD);

    const clientId = (await register(t)).body.client_id;
    const request = queryOf((await authorize(t, authorizeParams(clientId, pkce().challenge))).location).get('request')!;
    const consent = await api.oauth.consent(request);
    expect(consent.client.id).toBe(clientId);
    const { redirect_to } = await api.oauth.decide({ request, decision: 'approve', scopes: ['agents:read'] });
    expect(redirect_to.startsWith(REDIRECT)).toBe(true);
    await expect(api.oauth.decide({ request, decision: 'approve' })).rejects.toMatchObject({
      status: 400,
      code: 'oauth_request_invalid',
    });

    const grants = await api.me.grants.list();
    expect(grants.items.map((grant) => [grant.client.id, grant.scopes])).toEqual([[clientId, ['agents:read']]]);
    await api.me.grants.revoke(grants.items[0]!.id);
    expect((await api.me.grants.list()).items).toEqual([]);

    const created = await api.me.tokens.create({ name: 'CLI', scopes: ['runs:read'], expires_in_days: 90 });
    expect((await mcp(t, created.token)).status).toBe(200);
    expect((await api.me.tokens.list()).items.map((token) => token.name)).toEqual(['CLI']);
    await api.me.tokens.revoke(created.id);
    expect((await mcp(t, created.token)).status).toBe(401);
  });

  it('lets an admin manage clients', async () => {
    const t = createTestApp();
    const admin = await t.member('admin', 'root@example.com');
    const api = clientFor(t);
    await api.auth.login('root@example.com', TEST_PASSWORD);

    const machine = await api.admin.clients.create({
      kind: 'machine',
      name: 'Robot',
      member_id: admin.id,
      scopes: ['agents:read'],
    });
    expect(machine.client_secret).toMatch(/^gnh_cs_/);
    const rotated = await api.admin.clients.rotateSecret(machine.client.id);
    expect(rotated.client_secret).not.toBe(machine.client_secret);
    expect((await api.admin.clients.update(machine.client.id, { status: 'disabled' })).status).toBe('disabled');
    expect((await api.admin.clients.get(machine.client.id)).name).toBe('Robot');
    expect((await api.admin.clients.list()).items.map((client) => client.id)).toEqual([machine.client.id]);
    await api.admin.clients.remove(machine.client.id);
    expect((await api.admin.clients.list()).items).toEqual([]);
  });
});
