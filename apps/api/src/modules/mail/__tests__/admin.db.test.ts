/** 管理 → 服务 → 邮箱: whether mail goes out, the Agent domain, and where vendors post received mail. */

import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditEvents, getDb } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';
import { AGENT_DOMAIN, mailApp } from './setup.js';

describe('管理 → 服务 → 邮箱', () => {
  it('says nothing is set up on a fresh deployment, and only to admins', async () => {
    const { call, member } = createTestApp();
    const admin = await member('admin');
    const lin = await member();
    expect((await call('GET', '/api/admin/mail', { token: lin.token })).status).toBe(403);
    expect((await call('GET', '/api/admin/mail', { token: admin.token })).body).toEqual({
      can_send: false,
      agent_domain: null,
      agent_domain_source: null,
      mailboxes: false,
      receivers: [],
    });
    expect((await call('POST', '/api/admin/mail/test', { token: admin.token })).body.error.code).toBe(
      'mail_not_configured',
    );
  });

  it('shows the receiving service with its inbound address, and the domain from env until one is saved', async () => {
    const { call, admin } = await mailApp();
    expect((await call('GET', '/api/admin/mail', { token: admin.token })).body).toEqual({
      can_send: true,
      agent_domain: AGENT_DOMAIN,
      agent_domain_source: 'env',
      mailboxes: true,
      receivers: [
        {
          instance_id: 'env-mail-resend',
          name: 'Resend',
          kind: 'resend',
          inbound_url: 'http://greenhouse.test/api/mail/inbound/env-mail-resend',
          primary: true,
        },
      ],
    });

    const saved = await call('PUT', '/api/admin/mail', {
      token: admin.token,
      body: { agent_domain: 'Bots.Acme.Test' },
    });
    expect(saved.body).toMatchObject({ agent_domain: 'bots.acme.test', agent_domain_source: 'workspace' });
    const [entry] = await getDb()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorId, admin.id), eq(auditEvents.action, 'mail.domain')));
    expect(entry).toMatchObject({ resourceId: 'mail', summary: 'agent_domain' });
    expect(
      (await call('PUT', '/api/admin/mail', { token: admin.token, body: { agent_domain: 'not a domain' } })).status,
    ).toBe(400);
    // Cleared, it falls back to MAIL_AGENT_DOMAIN.
    const cleared = await call('PUT', '/api/admin/mail', { token: admin.token, body: { agent_domain: null } });
    expect(cleared.body).toMatchObject({ agent_domain: AGENT_DOMAIN, agent_domain_source: 'env' });
  });

  it('sends the admin a test mail through the first service, and reports a failure', async () => {
    const { call, admin, resend } = await mailApp();
    const sent = await call('POST', '/api/admin/mail/test', { token: admin.token });
    expect(sent.body).toMatchObject({ ok: true, instance: 'Resend', error: null });
    expect(resend.state.sent).toEqual([
      expect.objectContaining({
        from: 'Greenhouse <gh@acme.test>',
        to: ['boss <boss@acme.test>'],
        subject: 'Greenhouse：测试邮件',
      }),
    ]);
    resend.state.sendFailure = { status: 403, body: { message: 'The acme.test domain is not verified.' } };
    const failed = await call('POST', '/api/admin/mail/test', { token: admin.token });
    expect(failed.body).toMatchObject({ ok: false, error: expect.stringContaining('not verified') });
  });

  it('checks the domain an admin saves through the binding too', async () => {
    const { call, admin } = await mailApp();
    const wrong = await call('PUT', '/api/admin/provider-bindings/mail', {
      token: admin.token,
      body: { instance_ids: ['env-mail-resend'], defaults: { agent_domain: 'nope' } },
    });
    expect(wrong.status).toBe(400);
    const unknown = await call('PUT', '/api/admin/provider-bindings/mail', {
      token: admin.token,
      body: { instance_ids: ['env-mail-resend'], defaults: { color: 'blue' } },
    });
    expect(unknown.status).toBe(400);
  });
});
