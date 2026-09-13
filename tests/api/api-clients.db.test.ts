/** Shared API-key persistence used by MCP legacy credentials and the LLM relay. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, getDb, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { generateApiKey, hashApiKey, isValidApiKeyFormat } from '../../apps/api/src/auth/api-key.js';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;
let internalUserId: string;

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const user = await db.users.create({
    email: 'api-client-test@example.internal',
    password_hash: 'not-used',
    nickname: 'API Client Test',
    role: 'team',
  });
  internalUserId = user.id;
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('API key primitives', () => {
  it('generates unique keys with a stable prefix and SHA-256 hash', () => {
    const first = generateApiKey();
    const second = generateApiKey();

    expect(first.raw).toMatch(/^lpai_sk_[a-f0-9]{64}$/);
    expect(first.hash).toHaveLength(64);
    expect(first.raw).not.toBe(second.raw);
    expect(hashApiKey(first.raw)).toBe(first.hash);
  });

  it('rejects malformed keys before a database lookup', () => {
    expect(isValidApiKeyFormat(generateApiKey().raw)).toBe(true);
    expect(isValidApiKeyFormat('invalid-key')).toBe(false);
    expect(isValidApiKeyFormat('lpai_sk_short')).toBe(false);
  });
});

describe('API clients retained for internal-user-bound integrations', () => {
  it('stores and resolves an MCP legacy key bound to an internal user', async () => {
    const { hash } = generateApiKey();
    const client = await db.apiClients.create({
      app_id: 'mcp-test-client',
      app_name: 'MCP Test Client',
      api_key_hash: hash,
      user_id: internalUserId,
      channel: 'a2a',
    });

    expect(client.channel).toBe('a2a');
    expect(client.user_id).toBe(internalUserId);
    expect((await db.apiClients.getByKeyHash(hash))?.id).toBe(client.id);
  });

  it('keeps API audit storage for MCP traffic', async () => {
    await getDb().apiAudit.record({
      app_id: 'mcp-test-client',
      endpoint: '/api/mcp',
      method: 'POST',
      user_id: internalUserId,
      channel: 'a2a',
      status_code: 200,
      duration_ms: 25,
      meta: { method: 'tools/list' },
      ip_address: '127.0.0.1',
    });

    const entries = await db.apiAudit.list({ app_id: 'mcp-test-client' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.endpoint).toBe('/api/mcp');
    expect(entries[0]?.user_id).toBe(internalUserId);
  });
});
