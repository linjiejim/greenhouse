/**
 * The vault's routes (SET-06): logins are each member's own, their values go in and never come
 * back out, sites and Agents are checked, and the vault is off without its key.
 */

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, vaultAccessLog, vaultItems } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

const PASSWORD = 'Tr0ub4dor&3-horse';
const USERNAME = 'lin.jie@example.com';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

describe('the vault', () => {
  it('saves a login and never returns its values, sealed at rest', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const created = await call('POST', '/api/me/vault', {
      token: lin.token,
      body: { label: 'GitHub', origins: ['github.com'], username: USERNAME, password: PASSWORD, totp: TOTP },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      label: 'GitHub',
      origins: ['https://github.com'],
      username_hint: 'li***@example.com',
      has_username: true,
      has_password: true,
      has_totp: true,
      policy: 'ask',
      always_origins: [],
      agent_ids: [],
      last_used_at: null,
    });
    const listed = await call('GET', '/api/me/vault', { token: lin.token });
    const one = await call('GET', `/api/me/vault/${created.body.id}`, { token: lin.token });
    for (const body of [created.body, listed.body, one.body]) {
      const json = JSON.stringify(body);
      for (const value of [PASSWORD, USERNAME, TOTP]) expect(json).not.toContain(value);
    }
    expect(listed.body).toMatchObject({ items: [{ id: created.body.id }], next_cursor: null });

    const [row] = await getDb().select().from(vaultItems).where(eq(vaultItems.id, created.body.id));
    for (const column of [row!.usernameEnc, row!.passwordEnc, row!.totpEnc]) {
      expect(column).toMatch(/^k1:/);
      for (const value of [PASSWORD, USERNAME, TOTP]) expect(column).not.toContain(value);
    }
  });

  it('changes a login: values left out stay, empty ones go, narrowed sites drop their always-allowed ones', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const { body: item } = await call('POST', '/api/me/vault', {
      token: lin.token,
      body: {
        label: 'Mail',
        origins: ['https://mail.example.com', '*.example.org'],
        username: USERNAME,
        password: PASSWORD,
        always_origins: ['https://mail.example.com', 'https://login.example.org'],
      },
    });
    expect(item.always_origins).toEqual(['https://mail.example.com', 'https://login.example.org']);
    const [before] = await getDb().select().from(vaultItems).where(eq(vaultItems.id, item.id));

    const renamed = await call('PATCH', `/api/me/vault/${item.id}`, { token: lin.token, body: { label: 'Work mail' } });
    expect(renamed.body).toMatchObject({ label: 'Work mail', has_username: true, has_password: true });
    const [kept] = await getDb().select().from(vaultItems).where(eq(vaultItems.id, item.id));
    expect(kept!.passwordEnc).toBe(before!.passwordEnc);

    const cleared = await call('PATCH', `/api/me/vault/${item.id}`, {
      token: lin.token,
      body: { password: '', policy: 'auto', origins: ['https://mail.example.com'] },
    });
    expect(cleared.body).toMatchObject({
      has_password: false,
      has_username: true,
      policy: 'auto',
      origins: ['https://mail.example.com'],
      always_origins: ['https://mail.example.com'],
    });
    const empty = await call('PATCH', `/api/me/vault/${item.id}`, { token: lin.token, body: { username: '' } });
    expect(empty.status).toBe(400);

    const removed = await call('DELETE', `/api/me/vault/${item.id}`, { token: lin.token });
    expect(removed.status).toBe(204);
    expect((await call('GET', `/api/me/vault/${item.id}`, { token: lin.token })).status).toBe(404);
  });

  it('checks sites, always-allowed sites, values and Agents', async () => {
    const { call, member } = createTestApp({ PUBLIC_URL: 'https://gh.example.test' });
    const lin = await member();
    const chen = await member();
    const own = await call('POST', '/api/agents', { token: lin.token, body: { name: 'Scout' } });
    const theirs = await call('POST', '/api/agents', { token: chen.token, body: { name: 'Spy' } });
    const save = (body: Record<string, unknown>) =>
      call('POST', '/api/me/vault', {
        token: lin.token,
        body: { label: 'Site', origins: ['example.com'], password: 'pw-123456', ...body },
      });

    expect((await save({ origins: ['https://example.com/login'] })).body.error.code).toBe('origin_invalid');
    expect((await save({ origins: ['http://example.com'] })).body.error.code).toBe('origin_invalid');
    expect((await save({ origins: ['https://gh.example.test'] })).body.error.code).toBe('origin_forbidden');
    expect((await save({ origins: ['*.example.test'] })).body.error.code).toBe('origin_forbidden');
    expect((await save({ origins: [] })).status).toBe(400);
    expect((await save({ always_origins: ['https://other.example.com'] })).status).toBe(400);
    expect((await save({ password: '', username: '', totp: '' })).status).toBe(400);
    expect((await save({ password: 'two\nlines' })).status).toBe(400);
    expect((await save({ totp: 'not-a-secret' })).body.error.code).toBe('totp_invalid');
    expect((await save({ agent_ids: [theirs.body.id] })).status).toBe(400);
    const limited = await save({ agent_ids: [own.body.id, own.body.id] });
    expect(limited.body.agent_ids).toEqual([own.body.id]);
    // Local pages are allowed while testing.
    expect((await save({ origins: ['http://localhost:8765'] })).status).toBe(201);
  });

  it("is each member's own: another member sees, changes and deletes nothing, and reads only their own log", async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const chen = await member();
    const admin = await member('admin');
    const { body: item } = await call('POST', '/api/me/vault', {
      token: lin.token,
      body: { label: 'Bank', origins: ['bank.example.com'], password: PASSWORD },
    });
    await getDb().insert(vaultAccessLog).values({
      memberId: lin.id,
      itemId: item.id,
      itemLabel: 'Bank',
      agentId: null,
      conversationId: null,
      origin: 'https://bank.example.com',
      action: 'fill',
      outcome: 'filled',
      approval: 'auto',
    });
    for (const other of [chen, admin]) {
      expect((await call('GET', `/api/me/vault/${item.id}`, { token: other.token })).status).toBe(404);
      expect(
        (await call('PATCH', `/api/me/vault/${item.id}`, { token: other.token, body: { label: 'x' } })).status,
      ).toBe(404);
      expect((await call('DELETE', `/api/me/vault/${item.id}`, { token: other.token })).status).toBe(404);
      expect((await call('GET', '/api/me/vault', { token: other.token })).body.items).toEqual([]);
      expect((await call('GET', '/api/me/vault/log', { token: other.token })).body.items).toEqual([]);
    }
    const log = await call('GET', '/api/me/vault/log', { token: lin.token });
    expect(log.body.items).toEqual([
      expect.objectContaining({ item_id: item.id, item_label: 'Bank', outcome: 'filled', approval: 'auto' }),
    ]);
    // Deleting the login keeps its history, with its label.
    await call('DELETE', `/api/me/vault/${item.id}`, { token: lin.token });
    const after = await call('GET', '/api/me/vault/log', { token: lin.token });
    expect(after.body.items).toEqual([expect.objectContaining({ item_id: null, item_label: 'Bank' })]);
  });

  it('pages the log newest first', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    for (const outcome of ['requested', 'filled', 'declined'] as const) {
      await getDb().insert(vaultAccessLog).values({
        memberId: lin.id,
        itemLabel: 'Site',
        origin: 'https://example.com',
        action: 'fill',
        outcome,
      });
    }
    const first = await call('GET', '/api/me/vault/log?limit=2', { token: lin.token });
    expect(first.body.items.map((entry: { outcome: string }) => entry.outcome)).toEqual(['declined', 'filled']);
    const rest = await call('GET', `/api/me/vault/log?limit=2&cursor=${first.body.next_cursor}`, { token: lin.token });
    expect(rest.body).toMatchObject({ items: [{ outcome: 'requested' }], next_cursor: null });
  });

  it('is off without its key', async () => {
    const { call, member } = createTestApp({ VAULT_ENCRYPTION_KEY: '' });
    const lin = await member();
    for (const [method, path] of [
      ['GET', '/api/me/vault'],
      ['POST', '/api/me/vault'],
      ['GET', '/api/me/vault/log'],
    ] as const) {
      const response = await call(method, path, {
        token: lin.token,
        ...(method === 'POST' ? { body: { label: 'x', origins: ['example.com'], password: 'pw-123456' } } : {}),
      });
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('vault_unavailable');
    }
  });
});
