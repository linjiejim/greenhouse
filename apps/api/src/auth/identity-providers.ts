/** Identity adapters keep their protocol; account eligibility and binding rules stay in core. */
import { Hono, type Handler } from 'hono';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';
import { getAuthUser, requireInternal } from './middleware.js';
import { getDb } from '@greenhouse/db';

export interface IdentityProvider {
  id: string;
  title: string;
  icon: string;
  login: boolean;
  bind: boolean;
  path: string;
  available(): boolean;
  start: Handler<AppEnv>;
  callback: Handler<AppEnv>;
}
let providers: readonly IdentityProvider[] = [];
export function registerIdentityProviders(items: readonly IdentityProvider[]): void {
  if (new Set(items.map((p) => p.id)).size !== items.length) throw new Error('Duplicate identity provider');
  providers = [...items];
}
export function identityProviders(): readonly IdentityProvider[] {
  return providers;
}
export function isLoginEligible(user: UserRow): boolean {
  return user.status === 'active' && (user.role === 'team' || user.role === 'super');
}
export async function bindProviderIdentity(
  db: DatabaseProvider,
  provider: string,
  userId: string,
  identity: { id: string; name?: string },
): Promise<string | null> {
  const owner = await db.users.getById(userId);
  if (!owner || !isLoginEligible(owner)) return 'account_inactive';
  const existing = await db.providerTokens.findByProviderUserId(provider, identity.id);
  if (existing && existing.user_id !== userId) return 'already_bound';
  await db.providerTokens.upsert({
    user_id: userId,
    provider,
    workspace_id: null,
    provider_user_id: identity.id,
    ...(identity.name ? { provider_name: identity.name } : {}),
    access_token: null,
  });
  return null;
}
/** Callback authentication is single-use state; only start and binding need a bearer. */
export function createIdentityProviderRoutes(provider: IdentityProvider) {
  const app = new Hono<AppEnv>().get('/oauth/callback', provider.callback);
  if (!provider.bind) return app;
  return app
    .use('/oauth/start', requireInternal())
    .use('/binding', requireInternal())
    .get('/oauth/start', provider.start)
    .get('/binding', async (c) => {
      const binding = await getDb().providerTokens.get(getAuthUser(c).id, provider.id, null);
      return c.json({
        available: provider.available(),
        binding: binding
          ? {
              provider_user_id: binding.provider_user_id,
              provider_name: binding.provider_name,
              bound_at: binding.updated_at,
            }
          : null,
      });
    })
    .delete('/binding', async (c) => {
      await getDb().providerTokens.delete(getAuthUser(c).id, provider.id, null);
      return c.json({ ok: true });
    });
}
export const identityDiscoveryRoutes = new Hono<AppEnv>().get('/providers', (c) =>
  c.json({
    providers: identityProviders()
      .filter((p) => p.available())
      .map(({ id, title, icon, login }) => ({ id, title, icon, login })),
  }),
);

export async function issueUserSession(user: UserRow) {
  return (await import('../routes/auth.js')).issueUserSession(user);
}
