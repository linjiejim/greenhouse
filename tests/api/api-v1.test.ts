/**
 * 外部 API (v1) 单元测试 — API Key、客户端管理、审计日志、会话隔离。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, getDb } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { generateApiKey, hashApiKey, isValidApiKeyFormat } from '../../apps/api/src/auth/api-key.js';

let db: DatabaseProvider;

beforeAll(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test' });
  await db.resetSchema();
});

afterAll(async () => {
  await db.close();
});

// ─── API Key Generation ──────────────────────────────────

describe('API Key Generation', () => {
  it('generates key with correct prefix and length', () => {
    const { raw, hash } = generateApiKey();
    expect(raw).toMatch(/^gh_sk_[a-f0-9]{64}$/);
    expect(hash).toHaveLength(64); // SHA-256 hex
  });

  it('generates unique keys', () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(key1.raw).not.toBe(key2.raw);
    expect(key1.hash).not.toBe(key2.hash);
  });

  it('hashing is deterministic', () => {
    const { raw } = generateApiKey();
    const hash1 = hashApiKey(raw);
    const hash2 = hashApiKey(raw);
    expect(hash1).toBe(hash2);
  });

  it('validates key format', () => {
    const { raw } = generateApiKey();
    expect(isValidApiKeyFormat(raw)).toBe(true);
    expect(isValidApiKeyFormat('invalid-key')).toBe(false);
    expect(isValidApiKeyFormat('gh_sk_short')).toBe(false);
    expect(isValidApiKeyFormat('')).toBe(false);
    expect(isValidApiKeyFormat('gh_sk_' + 'a'.repeat(64))).toBe(true);
  });
});

// ─── API Client Repository ──────────────────────────────

describe('ApiClientRepository', () => {
  it('creates a client', async () => {
    const { hash } = generateApiKey();
    const client = await db.apiClients.create({
      app_id: 'test-app',
      app_name: 'Test Application',
      api_key_hash: hash,
    });

    expect(client.id).toBeDefined();
    expect(client.app_id).toBe('test-app');
    expect(client.app_name).toBe('Test Application');
    expect(client.status).toBe('active');
    expect(client.rate_limit_rpm).toBe(60);
    expect(client.rate_limit_rpd).toBe(10000);
    expect(client.daily_token_limit).toBe(50_000_000);
    expect(JSON.parse(client.allowed_profiles)).toEqual(['default']);
  });

  it('rejects duplicate app_id', async () => {
    const { hash } = generateApiKey();
    await expect(
      db.apiClients.create({
        app_id: 'test-app',
        app_name: 'Duplicate',
        api_key_hash: hash,
      }),
    ).rejects.toThrow();
  });

  it('finds by app_id', async () => {
    const client = await db.apiClients.getByAppId('test-app');
    expect(client).toBeDefined();
    expect(client!.app_id).toBe('test-app');
  });

  it('finds by key hash', async () => {
    const client = await db.apiClients.getByAppId('test-app');
    const found = await db.apiClients.getByKeyHash(client!.api_key_hash);
    expect(found).toBeDefined();
    expect(found!.app_id).toBe('test-app');
  });

  it('does not find disabled client by key hash', async () => {
    const client = await db.apiClients.getByAppId('test-app');
    await db.apiClients.update(client!.id, { status: 'disabled' });
    const found = await db.apiClients.getByKeyHash(client!.api_key_hash);
    expect(found).toBeUndefined();

    // Restore active status
    await db.apiClients.update(client!.id, { status: 'active' });
  });

  it('updates client config', async () => {
    const client = await db.apiClients.getByAppId('test-app');
    const updated = await db.apiClients.update(client!.id, {
      app_name: 'Updated Name',
      rate_limit_rpm: 120,
      allowed_profiles: ['default', 'team'],
    });

    expect(updated!.app_name).toBe('Updated Name');
    expect(updated!.rate_limit_rpm).toBe(120);
    expect(JSON.parse(updated!.allowed_profiles)).toEqual(['default', 'team']);
  });

  it('lists all clients', async () => {
    const clients = await db.apiClients.list();
    expect(clients.length).toBeGreaterThanOrEqual(1);
  });

  it('rotates API key', async () => {
    const client = await db.apiClients.getByAppId('test-app');
    const oldHash = client!.api_key_hash;

    const { hash: newHash } = generateApiKey();
    await db.apiClients.update(client!.id, { api_key_hash: newHash });

    const updated = await db.apiClients.getById(client!.id);
    expect(updated!.api_key_hash).toBe(newHash);
    expect(updated!.api_key_hash).not.toBe(oldHash);

    // Old key should not find client
    const notFound = await db.apiClients.getByKeyHash(oldHash);
    expect(notFound).toBeUndefined();
  });

  it('deletes a client', async () => {
    const { hash } = generateApiKey();
    const client = await db.apiClients.create({
      app_id: 'delete-me',
      app_name: 'To Delete',
      api_key_hash: hash,
    });

    const deleted = await db.apiClients.delete(client.id);
    expect(deleted).toBe(true);

    const found = await db.apiClients.getById(client.id);
    expect(found).toBeUndefined();
  });
});

// ─── API Audit Repository ────────────────────────────────

describe('ApiAuditRepository', () => {
  it('records audit entries', async () => {
    await db.apiAudit.record({
      app_id: 'test-app',
      endpoint: '/api/v1/chat/completions',
      method: 'POST',
      session_id: 'sess-1',
      ext_user_id: 'user-ext-1',
      status_code: 200,
      duration_ms: 1500,
      input_tokens: 100,
      output_tokens: 200,
      meta: { platform: 'ios' },
      ip_address: '1.2.3.4',
    });

    await db.apiAudit.record({
      app_id: 'test-app',
      endpoint: '/api/v1/chat/completions',
      method: 'POST',
      status_code: 429,
      duration_ms: 10,
      error: 'Rate limited',
      ip_address: '1.2.3.4',
    });
  });

  it('lists audit entries', async () => {
    const entries = await db.apiAudit.list({ app_id: 'test-app' });
    expect(entries.length).toBe(2);
    // Both entries should exist (order may vary within same second)
    const statusCodes = entries.map(e => e.status_code).sort();
    expect(statusCodes).toEqual([200, 429]);
  });

  it('filters by ext_user_id', async () => {
    const entries = await db.apiAudit.list({
      app_id: 'test-app',
      ext_user_id: 'user-ext-1',
    });
    expect(entries.length).toBe(1);
    expect(entries[0].ext_user_id).toBe('user-ext-1');
  });

  it('counts entries', async () => {
    const count = await db.apiAudit.count({ app_id: 'test-app' });
    expect(count).toBe(2);
  });

  it('calculates daily token usage', async () => {
    const usage = await db.apiAudit.getDailyTokenUsage('test-app');
    expect(usage).toBe(300); // 100 input + 200 output from first entry
  });
});

// ─── Session with app_id (Isolation) ─────────────────────

describe('Session app_id isolation', () => {
  it('creates session with app_id', async () => {
    const session = await db.sessions.create('Test', 'default', undefined, 'test-app');
    expect(session.app_id).toBe('test-app');
  });

  it('creates internal session without app_id', async () => {
    const session = await db.sessions.create('Internal', 'default', 'user-1');
    expect(session.app_id).toBeNull();
  });

  it('retrieves session and verifies app_id', async () => {
    const created = await db.sessions.create('With App', 'default', undefined, 'my-app');
    const found = await db.sessions.getById(created.id);
    expect(found!.app_id).toBe('my-app');
  });
});
