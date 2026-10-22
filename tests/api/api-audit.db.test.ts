/** Shared audit persistence for MCP and Agent proxy traffic (`api_audit_log`). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, getDb, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;
let internalUserId: string;

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const user = await db.users.create({
    email: 'api-audit-test@example.internal',
    password_hash: 'not-used',
    nickname: 'API Audit Test',
    role: 'team',
  });
  internalUserId = user.id;
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('API audit log', () => {
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
