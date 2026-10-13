import { asc } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditEvents, getDb } from '@greenhouse/db';
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

  it('records who changed members and groups, naming fields but not values', async () => {
    const { call, member } = createTestApp();
    const admin = await member('admin');
    const invited = await call('POST', '/api/admin/members', {
      token: admin.token,
      body: { email: 'wu@example.com', name: '吴' },
    });
    await call('PATCH', `/api/admin/members/${invited.body.member.id}`, {
      token: admin.token,
      body: { name: '吴二', modules: { computer: false } },
    });
    await call('POST', `/api/admin/members/${invited.body.member.id}/link`, { token: admin.token });
    const group = await call('POST', '/api/admin/groups', { token: admin.token, body: { name: '设计组' } });
    await call('DELETE', `/api/admin/groups/${group.body.id}`, { token: admin.token });

    const events = await getDb().select().from(auditEvents).orderBy(asc(auditEvents.id));
    expect(events.map((event) => [event.action, event.actorId])).toEqual([
      ['member.invite', admin.id],
      ['member.update', admin.id],
      ['member.link', admin.id],
      ['group.create', admin.id],
      ['group.delete', admin.id],
    ]);
    expect(events[1]!.summary).toBe('modules, name');
    expect(JSON.stringify(events)).not.toContain('吴二');
  });
});
