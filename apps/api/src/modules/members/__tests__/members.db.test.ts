import { describe, expect, it } from 'vitest';
import { createTestApp, TEST_PASSWORD } from '../../../testing.js';

describe('members', () => {
  it('lets a member edit their profile and ends other sessions on a password change', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const updated = await call('PATCH', '/api/me', { token: lin.token, body: { name: '林杰', theme: 'dark' } });
    expect(updated.body).toMatchObject({ name: '林杰', theme: 'dark', modules: { knowledge: true } });

    const changed = await call('POST', '/api/me/password', {
      token: lin.token,
      body: { current_password: TEST_PASSWORD, new_password: 'a-brand-new-one' },
    });
    expect(changed.status).toBe(204);
    // The old access token carries the old auth_version.
    expect((await call('GET', '/api/me', { token: lin.token })).status).toBe(401);
  });

  it('keeps admin endpoints for admins', async () => {
    const { call, member } = createTestApp();
    const lin = await member();
    const denied = await call('GET', '/api/admin/members', { token: lin.token });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('forbidden');
    expect((await call('GET', '/api/admin/members')).status).toBe(401);
  });

  it('pages the member list with an opaque cursor', async () => {
    const { call, member } = createTestApp();
    const admin = await member('admin');
    for (let index = 0; index < 3; index++) await member();
    const first = await call('GET', '/api/admin/members?limit=2', { token: admin.token });
    expect(first.body.items).toHaveLength(2);
    const second = await call('GET', `/api/admin/members?limit=2&cursor=${first.body.next_cursor}`, {
      token: admin.token,
    });
    expect(second.body.items.length).toBeGreaterThanOrEqual(2);
    const ids = [...first.body.items, ...second.body.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never removes the last admin and signs out a disabled member at once', async () => {
    const { call, member } = createTestApp();
    const admin = await member('admin');
    const demote = await call('PATCH', `/api/admin/members/${admin.id}`, {
      token: admin.token,
      body: { role: 'member' },
    });
    expect(demote.body.error.code).toBe('last_admin');

    const chen = await member();
    expect((await call('GET', '/api/me', { token: chen.token })).status).toBe(200);
    const disabled = await call('PATCH', `/api/admin/members/${chen.id}`, {
      token: admin.token,
      body: { status: 'disabled', modules: { computer: false } },
    });
    expect(disabled.body).toMatchObject({ status: 'disabled', modules: { computer: false, knowledge: true } });
    expect((await call('GET', '/api/me', { token: chen.token })).status).toBe(401);
  });

  it('manages groups with unique names', async () => {
    const { call, member } = createTestApp();
    const admin = await member('admin');
    const chen = await member();
    const created = await call('POST', '/api/admin/groups', {
      token: admin.token,
      body: { name: '产品组', member_ids: [chen.id, 'mbr_unknown'] },
    });
    expect(created.body).toMatchObject({ name: '产品组', member_ids: [chen.id] });
    const clash = await call('POST', '/api/admin/groups', { token: admin.token, body: { name: '产品组' } });
    expect(clash.body.error.code).toBe('group_name_taken');
    expect((await call('DELETE', `/api/admin/groups/${created.body.id}`, { token: admin.token })).status).toBe(204);
  });
});
