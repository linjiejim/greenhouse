/** Test support: a configured app and members with tokens, inside the per-test transaction. */

import { getDb, members, newId, type MemberRole } from '@greenhouse/db';
import { createApp, createServices, type ServiceOptions, type Services } from './app.js';
import { hashPassword } from './auth/password.js';
import { loadConfig } from './config/index.js';

const testServices = new Set<Services>();

/** Called before test transaction rollback, including after a test timeout. */
export async function disposeTestServices(): Promise<void> {
  const services = [...testServices];
  testServices.clear();
  await Promise.all(services.map((service) => service.engine.shutdown({ graceMs: 0 })));
}

export const TEST_PASSWORD = 'correct horse battery';

export function createTestServices(overrides: Record<string, string> = {}, options: ServiceOptions = {}): Services {
  const services = createServices(
    loadConfig({
      AGENT_EVENT_MERGE_MS: '0',
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused/test',
      TOKEN_SIGNING_KEY: 'a'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
      VAULT_ENCRYPTION_KEY: 'c'.repeat(64),
      PUBLIC_URL: 'http://greenhouse.test',
      ...overrides,
    }),
    options,
  );
  testServices.add(services);
  return services;
}

export function createTestApp(overrides?: Record<string, string>, options?: ServiceOptions) {
  const services = createTestServices(overrides, options);
  const app = createApp(services);

  async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
    const response = await app.request(path, {
      method,
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as any) : null };
  }

  async function member(role: MemberRole = 'member', email = `${newId('member').toLowerCase()}@example.com`) {
    const [row] = await getDb()
      .insert(members)
      .values({
        id: newId('member'),
        email,
        name: email.split('@')[0]!,
        role,
        status: 'active',
        passwordHash: await hashPassword(TEST_PASSWORD),
      })
      .returning();
    return { ...row!, token: services.tokens.createAccessToken(row!.id, role, row!.authVersion) };
  }

  return { app, services, call, member };
}
