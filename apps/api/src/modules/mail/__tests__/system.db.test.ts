/**
 * System mail through the mail capability (AUTH-04): invitations and resets go out by mail when a
 * service can send, and the admin still gets the link to copy. Without one, the link is shown only.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authLinks, getDb } from '@greenhouse/db';
import { readMail, smtpInstance, startFakeSmtp, type FakeSmtp } from '../../channels/__tests__/fakes.js';
import { createTestApp } from '../../../testing.js';

let smtp: FakeSmtp | null = null;
afterEach(async () => {
  await smtp?.close();
  smtp = null;
});

async function setup(withMail = true) {
  const app = createTestApp();
  const admin = await app.member('admin', 'boss@acme.test');
  if (withMail) {
    smtp = await startFakeSmtp();
    await smtpInstance(app.call, admin.token, {
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none',
      fromAddress: 'gh@acme.test',
    });
  }
  return { ...app, admin };
}

describe('system mail', () => {
  it('mails an invitation with the activation link, and records that it went', async () => {
    const { call, admin } = await setup();
    const invited = await call('POST', '/api/admin/members', {
      token: admin.token,
      body: { email: 'mei@acme.test', name: 'Mei' },
    });
    expect(invited.status).toBe(201);
    expect(invited.body.link).toMatchObject({
      url: expect.stringMatching(/^http:\/\/greenhouse\.test\/#\/activate\?token=/),
      delivery: 'emailed',
    });
    expect(smtp!.mails).toHaveLength(1);
    const mail = await readMail(smtp!.mails[0]!);
    expect(mail.to).toEqual(['mei@acme.test']);
    expect(mail.subject).toBe('boss 邀请你加入 Greenhouse');
    expect(mail.text).toContain(invited.body.link.url);
    const [link] = await getDb().select().from(authLinks).where(eq(authLinks.memberId, invited.body.member.id));
    expect(link!.deliveryStatus).toBe('emailed');
  });

  it('mails a reset link to an active member; the reset opens the same page as an activation', async () => {
    const { call, admin, member } = await setup();
    const lin = await member('member', 'lin@acme.test');
    const link = await call('POST', `/api/admin/members/${lin.id}/link`, { token: admin.token });
    expect(link.body).toMatchObject({ url: expect.stringContaining('/#/activate?token='), delivery: 'emailed' });
    const mail = await readMail(smtp!.mails[0]!);
    expect(mail.subject).toBe('重置你在 Greenhouse 的密码');
    expect(mail.text).toContain(link.body.url);
    // The link works: the page asks it what it is for.
    const token = new URL(link.body.url.replace('/#/', '/')).searchParams.get('token');
    expect((await call('GET', `/api/auth/links/inspect?token=${token}`)).body).toMatchObject({ purpose: 'reset' });
  });

  it('shows the link only when no service can send, and says when sending failed', async () => {
    const quiet = await setup(false);
    const shown = await quiet.call('POST', '/api/admin/members', {
      token: quiet.admin.token,
      body: { email: 'kai@acme.test', name: 'Kai' },
    });
    expect(shown.body.link.delivery).toBe('shown');
  });

  it('still hands the link over when the mail server is down', async () => {
    const { call, admin } = await setup();
    await smtp!.close();
    const invited = await call('POST', '/api/admin/members', {
      token: admin.token,
      body: { email: 'mei@acme.test', name: 'Mei' },
    });
    expect(invited.status).toBe(201);
    expect(invited.body.link).toMatchObject({ url: expect.stringContaining('#/activate?token='), delivery: 'failed' });
    const [link] = await getDb().select().from(authLinks).where(eq(authLinks.memberId, invited.body.member.id));
    expect(link!.deliveryStatus).toBe('failed');
  });
});
