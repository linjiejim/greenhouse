/**
 * The mail adapters against a real Resend or Mailgun account, the way the API uses them (the
 * registry's adapter, a fetch pinned to its endpoints). Opt-in: each run sends real mail.
 *
 *   RESEND_LIVE_API_KEY=re_… MAIL_LIVE_FROM=greenhouse@agents.example.com MAIL_LIVE_TO=you@example.com \
 *   [RESEND_LIVE_EMAIL_ID=<the id of a mail Resend received>] \
 *   npx vitest run --project unit apps/api/src/modules/mail/__tests__/mail.live.test.ts
 *
 *   MAILGUN_LIVE_API_KEY=… MAILGUN_LIVE_DOMAIN=agents.example.com [MAILGUN_LIVE_REGION=eu] \
 *   MAIL_LIVE_FROM=greenhouse@agents.example.com MAIL_LIVE_TO=you@example.com \
 *   [MAILGUN_LIVE_MESSAGE_URL=<the message-url of a stored mail>] npx vitest run … (same file)
 *
 * Covers: the test connection, a threaded mail sent from the configured sender, and one received
 * mail read back and normalised through the path the inbound route takes (when its id or stored
 * address is given; send a mail to an Agent address first and take the id from the vendor's log).
 */

import { describe, expect, it } from 'vitest';
import { getAdapter, MAILGUN_API, MAILGUN_EU_API, pinnedFetch, type MailClient } from '@greenhouse/providers';

const env = (name: string) => process.env[name]?.trim() || '';
const FROM = env('MAIL_LIVE_FROM');
const TO = env('MAIL_LIVE_TO');

function client(kind: 'resend' | 'mailgun', config: Record<string, unknown>, secrets: Record<string, string>) {
  const adapter = getAdapter('mail', kind)!;
  const parsed = adapter.configSchema.parse(config);
  return adapter.create({ config: parsed, secrets, fetch: pinnedFetch(adapter.endpoints(parsed)) }) as MailClient;
}

const stamp = () => new Date().toISOString();

describe.skipIf(!env('RESEND_LIVE_API_KEY') || !FROM || !TO)('Resend (live account)', () => {
  const resend = () =>
    client(
      'resend',
      { fromAddress: FROM, fromName: 'Greenhouse live test' },
      {
        apiKey: env('RESEND_LIVE_API_KEY'),
        // Present so the client can read received mail; nothing is verified against it here.
        webhookSecret: `whsec_${Buffer.from('live').toString('base64')}`,
      },
    );

  it('tests the key and sends a threaded mail', async () => {
    const mail = resend();
    await mail.verify();
    const sent = await mail.send({
      to: [{ address: TO }],
      subject: `Greenhouse live test ${stamp()}`,
      text: 'Sent by apps/api/src/modules/mail/__tests__/mail.live.test.ts.',
      inReplyTo: '<greenhouse-live-test@example.com>',
      references: ['<greenhouse-live-test@example.com>'],
    });
    expect(sent.providerId).toBeTruthy();
  }, 30_000);

  it.skipIf(!env('RESEND_LIVE_EMAIL_ID'))(
    'reads a received mail back, with the verdicts',
    async () => {
      const mail = await resend().receive!.fetch({
        ref: env('RESEND_LIVE_EMAIL_ID'),
        nonce: 'live',
        nonceTtlSeconds: 1,
      });
      expect(mail.providerMessageId).toBe(env('RESEND_LIVE_EMAIL_ID'));
      expect(mail.from.address).toContain('@');
      expect(['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'unknown']).toContain(
        mail.auth.spf,
      );
    },
    60_000,
  );
});

describe.skipIf(!env('MAILGUN_LIVE_API_KEY') || !env('MAILGUN_LIVE_DOMAIN') || !FROM || !TO)(
  'Mailgun (live account)',
  () => {
    const mailgun = () =>
      client(
        'mailgun',
        {
          baseUrl: env('MAILGUN_LIVE_REGION') === 'eu' ? MAILGUN_EU_API : MAILGUN_API,
          domain: env('MAILGUN_LIVE_DOMAIN'),
          fromAddress: FROM,
          fromName: 'Greenhouse live test',
        },
        { apiKey: env('MAILGUN_LIVE_API_KEY'), webhookSigningKey: 'live' },
      );

    it('tests the key and sends a threaded mail', async () => {
      const mail = mailgun();
      await mail.verify();
      const sent = await mail.send({
        to: [{ address: TO }],
        subject: `Greenhouse live test ${stamp()}`,
        text: 'Sent by apps/api/src/modules/mail/__tests__/mail.live.test.ts.',
        inReplyTo: '<greenhouse-live-test@example.com>',
        references: ['<greenhouse-live-test@example.com>'],
      });
      expect(sent.messageId).toMatch(/^<.+>$/);
    }, 30_000);

    it.skipIf(!env('MAILGUN_LIVE_MESSAGE_URL'))(
      'reads a stored mail back, with the verdicts',
      async () => {
        const mail = await mailgun().receive!.fetch({
          ref: env('MAILGUN_LIVE_MESSAGE_URL'),
          nonce: 'live',
          nonceTtlSeconds: 1,
        });
        expect(mail.from.address).toContain('@');
        expect(mail.recipients.length).toBeGreaterThan(0);
      },
      60_000,
    );
  },
);
