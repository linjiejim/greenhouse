import { afterEach, describe, expect, it } from 'vitest';
import { pinnedFetch, UndeliverableError } from '@greenhouse/providers';
import { smtpAdapter, smtpPort } from '../smtp.js';
import { readMail, startFakeSmtp, type FakeSmtp } from '../../channels/__tests__/fakes.js';

let server: FakeSmtp | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function client(config: Record<string, unknown>, password?: string) {
  const parsed = smtpAdapter.configSchema.parse(config);
  return smtpAdapter.create({
    config: parsed,
    secrets: password ? { password } : {},
    fetch: pinnedFetch(smtpAdapter.endpoints(parsed)),
  });
}

describe('the SMTP adapter', () => {
  it('signs in and sends a plain text and HTML message', async () => {
    server = await startFakeSmtp();
    const mail = client(
      {
        host: '127.0.0.1',
        port: server.port,
        security: 'none',
        username: 'bot@acme.com',
        fromAddress: 'bot@acme.com',
        fromName: 'Acme 温室',
      },
      'app-password',
    );
    await mail.verify();
    const sent = await mail.send({
      to: [{ address: 'lin@acme.com', name: 'Lin' }],
      subject: 'Greeny：请你批准一个操作',
      text: '打开查看: https://gh.acme.com/#/c/cnv_1',
      html: '<p><a href="https://gh.acme.com/#/c/cnv_1">打开查看</a></p>',
    });
    expect(sent.messageId).toMatch(/^<.+@.+>$/);
    expect(sent.providerId).toBe(sent.messageId);
    expect(server.mails).toHaveLength(1);
    const [received] = server.mails;
    expect(received).toMatchObject({ from: 'bot@acme.com', to: ['lin@acme.com'], auth: 'bot@acme.com:app-password' });
    const read = await readMail(received!);
    expect(read.subject).toBe('Greeny：请你批准一个操作');
    expect(read.text.trim()).toBe('打开查看: https://gh.acme.com/#/c/cnv_1');
    expect(read.html).toContain('href="https://gh.acme.com/#/c/cnv_1"');
    expect(received!.raw).toMatch(/^From: .*<bot@acme\.com>/m);
  });

  it('sends without signing in to a relay that needs none', async () => {
    server = await startFakeSmtp();
    await client({ host: '127.0.0.1', port: server.port, security: 'none', fromAddress: 'gh@acme.com' }).send({
      to: [{ address: 'lin@acme.com' }],
      subject: 'Hi',
      text: 'Hello',
    });
    expect(server.mails[0]).toMatchObject({ auth: null, from: 'gh@acme.com' });
  });

  it('sends from another address when told, with the threading headers and no header injection', async () => {
    server = await startFakeSmtp();
    await client({ host: '127.0.0.1', port: server.port, security: 'none', fromAddress: 'gh@acme.com' }).send({
      from: { address: 'greeny-k3v9@agents.acme.com', name: 'Greeny\r\nBcc: evil@x.com' },
      to: [{ address: 'lin@acme.com' }, { address: 'mei@acme.com' }],
      cc: [{ address: 'kai@acme.com' }],
      subject: 'Re: plan\r\nBcc: evil@x.com',
      text: 'Agreed.',
      inReplyTo: '<a1@mail.acme.com>',
      references: ['<a0@mail.acme.com>', '<a1@mail.acme.com>'],
    });
    const [received] = server.mails;
    expect(received).toMatchObject({ from: 'greeny-k3v9@agents.acme.com' });
    expect(received!.to.sort()).toEqual(['kai@acme.com', 'lin@acme.com', 'mei@acme.com']);
    expect(received!.raw).toMatch(/^In-Reply-To: <a1@mail\.acme\.com>/m);
    expect(received!.raw).toMatch(/^References: <a0@mail\.acme\.com> <a1@mail\.acme\.com>/m);
    expect(received!.raw).not.toMatch(/^Bcc:/im);
    expect((await readMail(received!)).subject).toBe('Re: plan Bcc: evil@x.com');
  });

  it('tells a refused recipient apart from a passing failure, without the password', async () => {
    server = await startFakeSmtp();
    server.refuse.set('gone@acme.com', '550 5.1.1 no such user');
    const mail = client(
      { host: '127.0.0.1', port: server.port, security: 'none', username: 'bot', fromAddress: 'bot@acme.com' },
      'app-password',
    );
    const refused = await mail
      .send({ to: [{ address: 'gone@acme.com' }], subject: 'x', text: 'y' })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UndeliverableError);

    server.answers.push('451 4.3.0 try again later');
    const later = await mail
      .send({ to: [{ address: 'lin@acme.com' }], subject: 'x', text: 'y' })
      .catch((error: unknown) => error);
    expect(later).toBeInstanceOf(Error);
    expect(later).not.toBeInstanceOf(UndeliverableError);
    expect(String(later)).toContain('451');
    expect(String(later)).not.toContain('app-password');

    const closed = client({ host: '127.0.0.1', port: 1, security: 'none', fromAddress: 'bot@acme.com' });
    const unreachable = await closed.verify().catch((error: unknown) => error);
    expect(unreachable).not.toBeInstanceOf(UndeliverableError);
    expect(String(unreachable)).toMatch(/^Error: SMTP: /);
  });

  it('knows its address, so moving it drops the password', () => {
    const config = smtpAdapter.configSchema.parse({ host: 'smtp.acme.com', fromAddress: 'gh@acme.com' });
    expect(config.security).toBe('starttls');
    expect(smtpPort(config)).toBe(587);
    expect(smtpPort({ security: 'tls' })).toBe(465);
    expect(smtpAdapter.endpoints(config)).toEqual(['smtp://smtp.acme.com:587']);
    expect(smtpAdapter.configSchema.safeParse({ host: 'smtp.acme.com/evil', fromAddress: 'gh@acme.com' }).success).toBe(
      false,
    );
  });
});
