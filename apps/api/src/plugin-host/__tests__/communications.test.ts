import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../app-env.js';

vi.stubEnv('GREENHOUSE_EXTENSIONS', 'communication-fixture');
vi.mock('../compiled.generated.js', () => ({
  COMPILED_PLUGINS: [
    {
      id: 'communication-fixture',
      name: 'Fixture',
      sdk: 2,
      core: '>=3 <5',
      notificationKinds: ['ext:communication-fixture:ready'],
      notificationTransports: [
        {
          id: 'fixture',
          title: 'Fixture',
          deliver: async () => ({ ok: true }),
          bindingSettings: { preference: 'fixture', label: 'Fixture' },
        },
      ],
      identityProviders: [
        {
          id: 'fixture',
          title: 'Fixture sign-in',
          icon: 'LogIn',
          login: true,
          bind: true,
          path: '/api/fixture',
          available: () => true,
          start: (c: import('hono').Context) => c.json({ authorize_url: 'https://identity.example/' }),
          callback: (c: import('hono').Context) => c.redirect('/#/settings/provider-bindings'),
        },
      ],
      channels: [{ id: 'fixture', start: () => () => {} }],
    },
  ],
}));
afterEach(() => vi.unstubAllEnvs());

describe('communication registry contributions', () => {
  it('activates transport, kind, identity and channel contributions from one fixture plugin', async () => {
    const { fromExtensions } = await import('../index.js');
    const { notificationTransports } = await import('../../notifications/transports.js');
    const { isNotificationKind, isNotificationChannel } = await import('@greenhouse/types/notification');
    expect(notificationTransports().map((t) => t.id)).toEqual(['fixture']);
    expect(isNotificationKind('ext:communication-fixture:ready')).toBe(true);
    expect(isNotificationKind('ext:disabled:ready')).toBe(false);
    expect(isNotificationChannel('fixture')).toBe(true);
    expect(fromExtensions('channels').map((c) => c.id)).toEqual(['fixture']);
    expect(notificationTransports()[0].bindingSettings?.preference).toBe('fixture');
  });
  it('discovers public providers without minting a state and mounts state-authenticated callbacks', async () => {
    await import('../index.js');
    const { identityDiscoveryRoutes } = await import('../../auth/identity-providers.js');
    const { mountExtensionRoutes } = await import('../boot.js');
    const app = new Hono<AppEnv>().route('/api/auth', identityDiscoveryRoutes);
    mountExtensionRoutes(app);
    expect(await (await app.request('/api/auth/providers')).json()).toEqual({
      providers: [{ id: 'fixture', title: 'Fixture sign-in', icon: 'LogIn', login: true }],
    });
    expect((await app.request('/api/fixture/oauth/callback')).status).toBe(302);
  });
  it('starts channels with the bound runtime and stops them exactly once', async () => {
    const { startChannels } = await import('../channels.js');
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const ctx = { db: {} as never, toolRegistry: {} };
    const shutdown = await startChannels([{ id: 'fixture', start }], ctx);
    expect(start).toHaveBeenCalledWith(ctx);
    await shutdown();
    await shutdown();
    expect(stop).toHaveBeenCalledOnce();
  });
  it('validates namespace ownership and refuses duplicate transports/providers', async () => {
    const { defineExtension } = await import('../define.js');
    const { registerNotificationTransports } = await import('../../notifications/transports.js');
    const { registerIdentityProviders, identityProviders } = await import('../../auth/identity-providers.js');
    expect(() => defineExtension({ id: 'private', name: 'Private', notificationKinds: ['system'] })).toThrow(
      'namespace',
    );
    const transport = { id: 'dupe', title: 'Duplicate', deliver: async () => ({ ok: true }) };
    expect(() => registerNotificationTransports([transport, transport])).toThrow('Duplicate');
    const provider = identityProviders()[0];
    expect(() => registerIdentityProviders([provider, provider])).toThrow('Duplicate');
  });
});
